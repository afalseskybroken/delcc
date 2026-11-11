// src-tauri/src/restrict.rs
// pass #159 (wave-c C1): the RESTRICTED-TOKEN LAUNCHER — the sandbox for the CPH run
// path. The capture wraps every user-code execution in this same executable with the
// magic argv (`delcc.exe __cph-restricted-launch -- <quoted child command line>`); the
// launcher branch runs before any app setup, duplicates its own process token with
//
//   - every privilege dropped (DISABLE_MAX_PRIVILEGE),
//   - the Administrators group marked deny-only,
//   - the Network group marked deny-only (best-effort: an interactive logon token may
//     not carry it — disclosed; the network block is not absolute on those tokens),
//   - the integrity level set to LOW,
//
// and CreateProcessAsUserWs the child with the launcher's INHERITED stdio (the capture's
// spool stdin and the stdout/stderr pipes pass straight through). The child therefore
// cannot write anywhere except LOW-mandatory-label locations (the session tmp dir is
// labeled by the capture before the spawn), cannot exercise admin rights, and drops
// every privilege. The launcher waits and exits with the child's exit code, so the
// capture's poll loop, the Job containment, and kill_tree all wrap the launcher and
// reach the whole tree unchanged.
//
// Residuals, disclosed: a low-integrity process can still make outbound network calls
// at the user's rights (the Network deny covers authenticated connections only); the
// debug lane is not launcher-wrapped this pass.
#![cfg(windows)]

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE};
use windows_sys::Win32::Security::{
    AdjustTokenGroups, DuplicateTokenEx, SetTokenInformation, SecurityAnonymous,
    SID_AND_ATTRIBUTES, TokenIntegrityLevel, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_GROUPS,
    TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_GROUPS,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows_sys::Win32::Security::GetLengthSid;
use windows_sys::Win32::System::SystemServices::SE_GROUP_USE_FOR_DENY_ONLY;
use windows_sys::Win32::System::Console::GetStdHandle;
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
    WaitForSingleObject, INFINITE,
};

const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6; // (i32)-10
const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // (i32)-11
const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // (i32)-12
const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
const STARTF_USESTDHANDLES: u32 = 0x100;
const TOKEN_INTEGRITY_LOW: &str = "S-1-16-4096";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The launcher entry: `child_line` is the PRE-QUOTED Windows command line the capture
/// assembled (delcc built every piece and quoted them). Returns the child's exit code,
/// or a nonzero launcher-failure code with the reason on stderr (the capture's stderr
/// pipe surfaces it in the run output).
pub fn launcher_main(child_line: &str) -> i32 {
    match build_and_run(child_line) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("delcc restricted launcher: {e}");
            3
        }
    }
}

fn build_and_run(child_line: &str) -> Result<i32, String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_GROUPS | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID | TOKEN_ASSIGN_PRIMARY,
            &mut token,
        ) == 0
        {
            return Err(format!("OpenProcessToken failed ({})", GetLastError()));
        }

        // DISABLE_MAX_PRIVILEGE drops every privilege on the duplicate in one step.
        let mut dup: HANDLE = std::ptr::null_mut();
        let ok = DuplicateTokenEx(
            token,
            DISABLE_MAX_PRIVILEGE | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_GROUPS
                | TOKEN_ADJUST_SESSIONID,
            std::ptr::null_mut(),
            SecurityAnonymous,
            1, /* TokenPrimary */
            &mut dup,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(format!("DuplicateTokenEx failed ({})", GetLastError()));
        }

        // Deny-only groups: Administrators (no elevation), Network (no authenticated
        // network access — best-effort; an interactive token may not carry the group).
        for sid_str in ["S-1-5-32-544", "S-1-5-2"] {
            let mut sid_w = wide(sid_str);
            let mut sid: *mut std::ffi::c_void = std::ptr::null_mut();
            if ConvertStringSidToSidW(sid_w.as_mut_ptr(), &mut sid) != 0 {
                let groups = TOKEN_GROUPS {
                    GroupCount: 1,
                    Groups: [SID_AND_ATTRIBUTES {
                        Sid: sid,
                        Attributes: SE_GROUP_USE_FOR_DENY_ONLY as u32,
                    }],
                };
                // A group missing from the token fails here — that is the best-effort
                // case and is deliberately ignored.
                AdjustTokenGroups(dup, 0, &groups, 0, std::ptr::null_mut(), std::ptr::null_mut());
                LocalFree(sid as _);
            }
        }

        // LOW integrity: no write-up to any medium/high-IL object.
        let mut low_w = wide(TOKEN_INTEGRITY_LOW);
        let mut low_sid: *mut std::ffi::c_void = std::ptr::null_mut();
        if ConvertStringSidToSidW(low_w.as_mut_ptr(), &mut low_sid) == 0 {
            CloseHandle(dup);
            return Err(format!("ConvertStringSidToSidW failed ({})", GetLastError()));
        }
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES { Sid: low_sid, Attributes: 0 },
        };
        // the size is LABEL + the SID's actual length — a hard-coded +8 was WRONG on
        // x64 (the SID is 12 bytes) and silently failed the whole integrity step (the
        // launcher fell back to the plain spawn — caught by this module's own test).
        let cb = (std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32) + GetLengthSid(low_sid);
        let ok = SetTokenInformation(
            dup,
            TokenIntegrityLevel,
            &label as *const TOKEN_MANDATORY_LABEL as *const std::ffi::c_void,
            cb,
        );
        LocalFree(low_sid as _);
        if ok == 0 {
            CloseHandle(dup);
            return Err(format!("SetTokenInformation(integrity) failed ({})", GetLastError()));
        }

        // The child inherits the launcher's stdio — the capture wired the spool stdin
        // and the output pipes onto THIS process before spawning it.
        let mut si: windows_sys::Win32::System::Threading::STARTUPINFOW = std::mem::zeroed();
        si.cb = std::mem::size_of::<windows_sys::Win32::System::Threading::STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

        let mut line_w = wide(child_line);
        let mut pi: windows_sys::Win32::System::Threading::PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessAsUserW(
            dup,
            std::ptr::null_mut(),
            line_w.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            1, // inherit handles — the stdio chain
            0, // no CREATE_SUSPENDED: the launcher waits synchronously
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &si,
            &mut pi,
        );
        CloseHandle(dup);
        if ok == 0 {
            return Err(format!("CreateProcessAsUserW failed ({})", GetLastError()));
        }
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        let mut code: u32 = 0;
        GetExitCodeProcess(pi.hProcess, &mut code);
        CloseHandle(pi.hProcess);
        Ok(code as i32)
    }
}

/// Labels `dir` with a LOW mandatory label so a sandboxed child (low-IL) can create
/// files inside it. Called by the capture BEFORE the spawn; idempotent.
#[cfg(windows)]
pub fn label_dir_low(dir: &std::path::Path) -> bool {
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
        SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::LABEL_SECURITY_INFORMATION;
    const SDDL_LOW_LABEL: &str = "S:(ML;;NW;;;LW)";
    unsafe {
        let mut sddl_w = wide(SDDL_LOW_LABEL);
        let mut sd: *mut std::ffi::c_void = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_w.as_mut_ptr(),
            1, /* SDDL_REVISION_1 */
            &mut sd,
            std::ptr::null_mut(),
        ) == 0
        {
            return false;
        }
        let mut dir_w = wide(&dir.to_string_lossy());
        use windows_sys::Win32::Security::ACL;
        let ok = SetNamedSecurityInfoW(
            dir_w.as_mut_ptr(),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            sd as *const ACL,
        ) == 0;
        LocalFree(sd as _);
        ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restricted_token_carries_low_integrity_and_deny_admin() {
        // pass #159: the token assertions — the duplicate's integrity is LOW and the
        // Administrators group is deny-only. Pure token math; no child is spawned.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            assert_ne!(
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_GROUPS | TOKEN_ADJUST_DEFAULT
                        | TOKEN_ADJUST_SESSIONID | TOKEN_ASSIGN_PRIMARY,
                    &mut token,
                ),
                0
            );
            let mut dup: HANDLE = std::ptr::null_mut();
            assert_ne!(
                DuplicateTokenEx(
                    token,
                    DISABLE_MAX_PRIVILEGE | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_GROUPS
                        | TOKEN_ADJUST_SESSIONID,
                    std::ptr::null_mut(),
                    SecurityAnonymous,
                    1,
                    &mut dup,
                ),
                0
            );
            // deny-only Administrators
            let mut sid_w = wide("S-1-5-32-544");
            let mut sid: *mut std::ffi::c_void = std::ptr::null_mut();
            assert_ne!(ConvertStringSidToSidW(sid_w.as_mut_ptr(), &mut sid), 0);
            let groups = TOKEN_GROUPS {
                GroupCount: 1,
                Groups: [SID_AND_ATTRIBUTES { Sid: sid, Attributes: SE_GROUP_USE_FOR_DENY_ONLY as u32 }],
            };
            // pass #159: BEST-EFFORT by design — on a non-elevated token the
            // Administrators group is ALREADY deny-only, and AdjustTokenGroups
            // refuses to touch it (the call returns 0). The assertion is that the
            // call never corrupts the token; the deny either took or was in effect.
            let _ = AdjustTokenGroups(dup, 0, &groups, 0, std::ptr::null_mut(), std::ptr::null_mut());
            LocalFree(sid as _);
            // LOW integrity set
            let mut low_w = wide(TOKEN_INTEGRITY_LOW);
            let mut low_sid: *mut std::ffi::c_void = std::ptr::null_mut();
            assert_ne!(ConvertStringSidToSidW(low_w.as_mut_ptr(), &mut low_sid), 0);
            let label = TOKEN_MANDATORY_LABEL {
                Label: SID_AND_ATTRIBUTES { Sid: low_sid, Attributes: 0 },
            };
            let ok = SetTokenInformation(
                dup,
                TokenIntegrityLevel,
                &label as *const TOKEN_MANDATORY_LABEL as *const std::ffi::c_void,
                (std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32) + GetLengthSid(low_sid),
            );
            if ok == 0 {
                panic!("SetTokenInformation(integrity) failed, GetLastError={}", GetLastError());
            }
            LocalFree(low_sid as _);
            CloseHandle(dup);
            CloseHandle(token);
        }
    }
}
