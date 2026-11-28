// src-tauri/src/restrict.rs
// pass #159-#160 (wave-c C1, He's epic): the SELF-RESTRICTING INTERMEDIATE.
//
// The architecture that actually works without privileges: CreateProcessAsUserW
// requires SeAssignPrimaryTokenPrivilege (the ingredient bisect proved it — even a
// bare duplicate of the caller's own token fails with ACCESS_DENIED on an
// interactive account), so the token is never duplicated and never handed to
// CreateProcessAsUser. Instead the capture wraps every untrusted contest-code RUN in THIS
// executable with the magic argv; the intermediate branch runs before any app
// setup and RESTRICTS ITS OWN PROCESS TOKEN — the MSDN DropMyPermissions pattern:
//
//   - every privilege disabled (AdjustTokenPrivileges, DisableAllPrivileges),
//   - the Administrators group marked deny-only (AdjustTokenGroups),
//   - the NETWORK group marked deny-only, best-effort (AdjustTokenGroups; pass #163/W12-08),
//   - the integrity level set to LOW (SetTokenInformation),
//
// all unprivileged on your own process token, then CreateProcessW's the child with
// bInheritHandles — the child inherits the restricted token AND the capture's
// stdio (the spool stdin and the output pipes pass straight through). The capture's
// poll loop, the Job containment, and kill_tree wrap the intermediate and reach the
// whole tree unchanged. The session tmp dir carries a LOW mandatory label (the
// sandboxed child's only writable corner).
//
// Residuals, disclosed: the Network group deny covers authenticated connections
// only; the compile step (trusted toolchains) and the debug lane are not
// sandboxed; the NUL-device substitution covers the streams the capture did not
// pipe (delcc is a windows-subsystem binary — a NULL std handle with
// STARTF_USESTDHANDLES failed CreateProcess with ERROR_FILE_NOT_FOUND, caught by
// the launcher's own live fire).
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, GENERIC_READ, GENERIC_WRITE, HANDLE};
use windows_sys::Win32::Security::{
    AdjustTokenGroups, AdjustTokenPrivileges, GetLengthSid, SetTokenInformation,
    SID_AND_ATTRIBUTES, TokenIntegrityLevel, TOKEN_ADJUST_GROUPS, TOKEN_ADJUST_PRIVILEGES,
    TOKEN_ADJUST_SESSIONID, TOKEN_ADJUST_DEFAULT, TOKEN_GROUPS, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TOKEN_WRITE,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::System::SystemServices::SE_GROUP_USE_FOR_DENY_ONLY;
use windows_sys::Win32::System::Console::GetStdHandle;
use windows_sys::Win32::Storage::FileSystem::CreateFileW;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
    WaitForSingleObject, INFINITE,
};

const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6;
const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5;
const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4;
const STARTF_USESTDHANDLES: u32 = 0x100;
const TOKEN_INTEGRITY_LOW: &str = "S-1-16-4096";
const NUL_DEVICE: &str = "\\\\.\\NUL";

fn ensure_stream(h: HANDLE, access: u32) -> HANDLE {
    const INVALID: HANDLE = -1isize as HANDLE;
    if !h.is_null() && h != INVALID {
        return h;
    }
    unsafe {
        use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let path = wide(NUL_DEVICE);
        let handle = CreateFileW(
            path.as_ptr(),
            access,
            0x1 | 0x2, // FILE_SHARE_READ | FILE_SHARE_WRITE
            &sa,
            3, // OPEN_EXISTING
            0,
            std::ptr::null_mut(),
        );
        if handle == INVALID {
            return std::ptr::null_mut();
        }
        handle
    }
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// The self-restriction, on the intermediate's OWN process token. Every step is
// unprivileged when applied to your own token (lowering is always allowed).
// Returns Err with the failing step — the caller refuses the run (fail-closed,
// the W11-02 doctrine: a run without its promised containment does not happen).
pub fn self_restrict() -> Result<(), String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_ADJUST_GROUPS | TOKEN_ADJUST_SESSIONID
                | TOKEN_ADJUST_DEFAULT | TOKEN_QUERY | TOKEN_WRITE,
            &mut token,
        ) == 0
        {
            return Err(format!("OpenProcessToken failed ({})", GetLastError()));
        }

        // 1) every privilege disabled (DisableAllPrivileges = TRUE)
        if AdjustTokenPrivileges(token, 1, std::ptr::null_mut(), 0, std::ptr::null_mut(), std::ptr::null_mut()) == 0 {
            CloseHandle(token);
            return Err(format!("AdjustTokenPrivileges(disable-all) failed ({})", GetLastError()));
        }

        // 2) the Administrators group deny-only. BEST-EFFORT: on a non-elevated
        // token the group is already deny-only and the call refuses to touch it —
        // the deny is in effect either way.
        let mut admin_w = wide("S-1-5-32-544");
        let mut admin_sid: *mut std::ffi::c_void = std::ptr::null_mut();
        if ConvertStringSidToSidW(admin_w.as_mut_ptr(), &mut admin_sid) != 0 {
            let groups = TOKEN_GROUPS {
                GroupCount: 1,
                Groups: [SID_AND_ATTRIBUTES {
                    Sid: admin_sid,
                    Attributes: SE_GROUP_USE_FOR_DENY_ONLY as u32,
                }],
            };
            let _ = AdjustTokenGroups(token, 0, &groups, 0, std::ptr::null_mut(), std::ptr::null_mut());
            LocalFree(admin_sid as _);
        }

        // 2b) pass #163 (wave-12 W12-08): the NETWORK group deny-only, BEST-EFFORT.
        // The #159 design disclosed it but the code never applied it. An interactive
        // logon token usually does not carry S-1-5-2, so this is a no-op there (the
        // disclosed residual); where the group IS present, denying it blocks
        // authenticated network access. LOW integrity itself does NOT block outbound
        // calls at the user's rights — disclosed in SECURITY.md.
        let mut net_w = wide("S-1-5-2");
        let mut net_sid: *mut std::ffi::c_void = std::ptr::null_mut();
        if ConvertStringSidToSidW(net_w.as_mut_ptr(), &mut net_sid) != 0 {
            let groups = TOKEN_GROUPS {
                GroupCount: 1,
                Groups: [SID_AND_ATTRIBUTES {
                    Sid: net_sid,
                    Attributes: SE_GROUP_USE_FOR_DENY_ONLY as u32,
                }],
            };
            let _ = AdjustTokenGroups(token, 0, &groups, 0, std::ptr::null_mut(), std::ptr::null_mut());
            LocalFree(net_sid as _);
        }

        // 3) LOW integrity. THE SIZE GOTCHA: the buffer is LABEL + the SID's actual
        // length — a hardcoded +8 is wrong on x64 and fails with ACCESS_DENIED
        // (caught by this module's own test in pass #159).
        let mut low_w = wide(TOKEN_INTEGRITY_LOW);
        let mut low_sid: *mut std::ffi::c_void = std::ptr::null_mut();
        if ConvertStringSidToSidW(low_w.as_mut_ptr(), &mut low_sid) == 0 {
            CloseHandle(token);
            return Err(format!("ConvertStringSidToSidW(integrity) failed ({})", GetLastError()));
        }
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES { Sid: low_sid, Attributes: 0 },
        };
        let ok = SetTokenInformation(
            token,
            TokenIntegrityLevel,
            &label as *const TOKEN_MANDATORY_LABEL as *const std::ffi::c_void,
            (std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32) + GetLengthSid(low_sid),
        );
        LocalFree(low_sid as _);
        CloseHandle(token);
        if ok == 0 {
            return Err(format!("SetTokenInformation(integrity) failed ({})", GetLastError()));
        }
        Ok(())
    }
}

/// The intermediate entry: `child_line` is the PRE-QUOTED Windows command line the
/// capture assembled. Restricts the current process, spawns the child, waits, exits
/// with the child's exit code — or exit code 3 with the reason on stderr.
pub fn restricted_child_main(child_line: &str) -> i32 {
    if let Err(e) = self_restrict() {
        eprintln!("delcc restricted child: {e}");
        return 3;
    }
    unsafe {
        use windows_sys::Win32::System::Threading::STARTUPINFOW;
        use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
        // pass #160: the intermediate's OWN std handles (the capture's pipes, or the
        // NUL device for the streams nobody piped) are passed to the child EXPLICITLY
        // — this is a windows-subsystem process; without STARTF_USESTDHANDLES the
        // child's std handles are NULL and its output vanishes.
        let std_in = ensure_stream(GetStdHandle(STD_INPUT_HANDLE), GENERIC_READ);
        let std_out = ensure_stream(GetStdHandle(STD_OUTPUT_HANDLE), GENERIC_WRITE);
        let std_err = ensure_stream(GetStdHandle(STD_ERROR_HANDLE), GENERIC_WRITE);
        let mut line_w = wide(child_line);
        let mut si: STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = std_in;
        si.hStdOutput = std_out;
        si.hStdError = std_err;
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        // bInheritHandles: the child inherits this process's std handles (the
        // capture's pipes) AND its restricted token.
        if CreateProcessW(
            std::ptr::null_mut(),
            line_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &si,
            &mut pi,
        ) == 0
        {
            eprintln!("delcc restricted child: CreateProcessW failed ({})", GetLastError());
            return 3;
        }
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        let mut code: u32 = 0;
        GetExitCodeProcess(pi.hProcess, &mut code);
        CloseHandle(pi.hProcess);
        code as i32
    }
}

/// pass #186: creates `path` with a LOW mandatory label AT CREATION TIME — the
/// documented no-privilege path. A no-write-up label assigned at object creation
/// needs no SeSecurityPrivilege; the post-creation SetNamedSecurityInfoW route
/// this replaces failed with ERROR_NO_TOKEN (1008) for any normal process —
/// the #182 fix's own bug, caught by the containment test (the wave-16 P1).
/// FAIL-CLOSED (the W11-02 doctrine): an already-existing dir is refused (it
/// cannot be proven labeled), never reused.
pub fn create_dir_low(path: &std::path::Path) -> Result<(), String> {
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    const SDDL_LOW_LABEL: &str = "S:(ML;;NW;;;LW)";
    unsafe {
        let mut sddl_w = wide(SDDL_LOW_LABEL);
        let mut sd: *mut std::ffi::c_void = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_w.as_mut_ptr(), 1, &mut sd, std::ptr::null_mut(),
        ) == 0 { return Err(format!("ConvertStringSecurityDescriptor failed ({})", GetLastError())); }
        let mut sa: SECURITY_ATTRIBUTES = std::mem::zeroed();
        sa.nLength = std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32;
        sa.lpSecurityDescriptor = sd;
        let mut path_w = wide(&path.to_string_lossy());
        let ok = CreateDirectoryW(path_w.as_mut_ptr(), &sa);
        let err = GetLastError();
        LocalFree(sd as _);
        if ok == 0 {
            if err == 183 { return Err("the session dir already exists and its label cannot be proven".into()); }
            return Err(format!("CreateDirectoryW failed ({err})"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_process_token_grants_the_adjust_rights() {
        // pass #160: the self-restrict path's prerequisites — the process token
        // must open with the adjust rights the three steps need. The steps
        // themselves are verified live (the run path exercises them on every run);
        // lowering YOUR OWN token is unprivileged, but the test process shares its
        // token with the whole test binary, so the test only proves the open.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            assert_ne!(
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_ADJUST_PRIVILEGES | TOKEN_ADJUST_GROUPS | TOKEN_ADJUST_SESSIONID
                        | TOKEN_ADJUST_DEFAULT | TOKEN_QUERY | TOKEN_WRITE,
                    &mut token,
                ),
                0
            );
            CloseHandle(token);
        }
    }
}

#[cfg(all(test, windows))]
mod sandbox_label_tests {
    use super::*;

    /// pass #186 (the wave-16 P1): the LABEL-EXISTENCE test — create_dir_low must
    /// actually install the no-write-up mandatory label, proven by the icacls
    /// read-back (the system tool reads the label without elevation). The wave-10
    /// class of silent failure (the labeling half never worked from #159 to #182)
    /// becomes a test failure instead of quiet degradation. Note: the write-up
    /// ENFORCEMENT is kernel-policy-dependent and is exercised live by every run;
    /// what this test pins is that the label INSTALLS.
    #[test]
    fn the_session_corner_carries_its_low_label() {
        let base = std::env::temp_dir().join(format!("delcc-label-test-{}", std::process::id()));
        let corner = base.join("corner");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("mkdir base");
        if let Err(e) = create_dir_low(&corner) {
            panic!("creating the labeled corner failed: {e}");
        }
        let out = std::process::Command::new("icacls")
            .arg(&corner)
            .output()
            .expect("icacls");
        let _ = std::fs::remove_dir_all(&base);
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        assert!(
            text.contains("mandatory label") && text.contains("low mandatory level"),
            "the corner must carry the LOW mandatory label (the icacls read-back); got:
{}",
            text.trim()
        );
    }
}
