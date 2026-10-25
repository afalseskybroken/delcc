# C4 — Windows 11 accent-color research digest

Tree: `delcc-app` — the current workspace name; no exported `tree-<stamp>` identifier was supplied.
Research date: 2026-10-23, Asia/Bangkok.
Scope: reading the interactive user's Windows accent for application UI. Research only; no application code, dependencies, registry settings, or builds changed. Examples are API-reference-checked illustrations, not compiled or executed receipts. Private-export availability and registry behavior were not measured on a particular Windows 11 build.

## 1. Route catalog

These are distinct source families; C#, PowerShell, Rust crates, and framework wrappers can expose the same underlying source. There is no finite list of every possible wrapper or private export.

| Route / call-site language | Stability | What it actually provides | Light/dark and principal caveat |
| --- | --- | --- | --- |
| WinRT `UISettings.GetColorValue` — C++/WinRT; Rust `windows` crate | Documented, preferred | Base accent and six generated shades, plus background/foreground | Select an appropriate shade for the app's resolved theme; an app override is independent of the OS preference. |
| WinRT `UISettings.UIElementColor(UIElementType::AccentColor)` — same languages | Documented alternative | The Windows personalization accent; other element types supply semantic colors | Useful for semantic/high-contrast palettes; not the seven-member accent-ramp API. |
| WinUI/UWP XAML theme resources — C++/WinRT or XAML framework interop | Documented framework facility | `SystemAccentColor` and theme resources | Application resource overrides can replace what a lookup returns. Tauri does not inherently host a XAML resource tree. |
| `DwmGetColorizationColor` — C/C++; Rust Win32 projection | Documented, legacy meaning | DWM glass-composition color and opaque-blend flag | A composition color is not a promise about the accent applied to every Windows 11 control. |
| Private DWM colorization exports — manually declared native FFI | Unsupported | Historical colorization parameters including balance/afterglow | Export identity, ABI and behavior require build-specific investigation. No supported light/dark ramp. |
| Private UxTheme immersive-color exports — manually declared native FFI | Unsupported | Historical named immersive-color/color-set lookups | Internal names, indices, high-contrast arguments and exports are not an app contract. |
| User registry values — C/C++ `RegGetValueW`; Rust Win32 registry projection | Reading API is supported; interpreting personalization storage is not a general theming contract | Stored accent/colorization values, palettes and application-location flags | Cached state, alternate encodings and missing values require validation; flags are not colors. |
| Classic system colors/theme APIs — C/C++, Rust Win32 or WinRT | Documented for their semantic roles | Selection, text, window and related colors | Useful for contrast themes; `COLOR_HIGHLIGHT` is not a substitute for the modern base accent. |
| CSS/WebView2 scheme and system-color facilities — DOM/CSS; WebView2 host C++/COM | Supported facilities, different purpose | Theme preference, native widget rendering and browser system colors | No documented general WebView2 property for obtaining the user's accent RGB was found in the reviewed references. CSS values need not expose OS personalization. |

The supported API claims above are detailed and sourced below. Private routes are cataloged as historical implementation evidence, not confirmed Windows 11 availability.

## 2. WinRT: the primary native source

`Windows.UI.ViewManagement.UISettings.GetColorValue(UIColorType)` returns a `Windows.UI.Color` with separate `A`, `R`, `G`, and `B` channels. This is a supported way for a native desktop process to read the accent; Rust can use the Microsoft-generated `windows` projection. [GetColorValue reference](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uisettings.getcolorvalue?view=winrt-26100), [Microsoft Rust projection](https://microsoft.github.io/windows-docs-rs/doc/windows/UI/ViewManagement/struct.UISettings.html).

All defined `UIColorType` values:

| Value | Member | Meaning |
| --- | --- | --- |
| 0 | `Background` | System UI background role. |
| 1 | `Foreground` | System UI foreground role. |
| 2, 3, 4 | `AccentDark3`, `AccentDark2`, `AccentDark1` | Darkest through dark accent shades. |
| 5 | `Accent` | Base accent. |
| 6, 7, 8 | `AccentLight1`, `AccentLight2`, `AccentLight3` | Light through lightest accent shades. |
| 9 | `Complement` | Explicitly unsupported; do not query it as a usable complement. |

These are palette entries, not a light-mode/dark-mode switch. Background/foreground are separate from accent selection. Do not assume that switching app theme changes the base accent, or that one shade has sufficient contrast against every surface. [UIColorType enum](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uicolortype?view=winrt-26100).

Rust illustration: `windows` 0.62.2 with feature `UI_ViewManagement`; caller owns Windows Runtime thread initialization. No Tauri integration implied:

```rust
use windows::{core::Result, UI::ViewManagement::{UIColorType, UISettings}};

fn accent_rgba() -> Result<[u8; 4]> {
    let settings = UISettings::new()?;
    let c = settings.GetColorValue(UIColorType::Accent)?;
    Ok([c.R, c.G, c.B, c.A])
}
```

For another documented getter, replace the lookup with `settings.UIElementColor(UIElementType::AccentColor)?`. `AccentColor` is enum value 1000. `Highlight`, `HighlightText`, `Window`, `WindowText`, `ButtonText`, and related element roles are separate queries, useful when implementing a semantic palette. They should not be conflated with the base accent. [UIElementType enum](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uielementtype?view=winrt-26100).

Subscribe to `UISettings.ColorValuesChanged`, then re-read the complete palette. Retain the settings object and registration token, and revoke the handler on shutdown. Treat callbacks as notification work: marshal UI mutation onto the UI thread rather than assuming the callback runs there. The event is documented; this digest has not measured callback scheduling or event coverage across Windows 11 builds. [ColorValuesChanged](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.uisettings.colorvalueschanged?view=winrt-26100).

Initialize WinRT on a thread that activates/uses these objects. If explicitly calling `RoInitialize`, balance each successful initialization with `RoUninitialize`; do not change an already-initialized UI thread's apartment model to MTA. A dedicated initialized worker is an integration option, not a reason to reinitialize Tauri's WebView thread blindly. [RoInitialize](https://learn.microsoft.com/en-us/windows/win32/api/roapi/nf-roapi-roinitialize).

## 3. Framework resource lookups and per-app colors

In an application already using XAML, `SystemAccentColor` resolves to the user's personalization accent, while theme-dependent brushes resolve differently for Light, Dark, and HighContrast. Framework color resources can be overridden by application resources; reading an effective brush therefore answers a different question from reading the unmodified OS preference. Use a theme-aware resource reference for rendered XAML rather than caching a brush forever. [XAML theme resources](https://learn.microsoft.com/en-us/windows/apps/develop/platform/xaml/xaml-theme-resources).

C++/WinRT illustration for an existing WinUI 3 application, not a drop-in Tauri dependency:

```cpp
auto resources = winrt::Microsoft::UI::Xaml::Application::Current().Resources();
auto accent = winrt::unbox_value<winrt::Windows::UI::Color>(
    resources.Lookup(winrt::box_value(winrt::hstring{L"SystemAccentColor"})));
```

Windows light/dark preference, selected accent, the application theme, and an app's custom accent are distinct inputs. There is no general getter for another application's custom brand color. The app must define how its explicit accent override and a “follow Windows” option interact. [Windows color guidance](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color).

## 4. DWM: documented getter versus private routes

**`DwmGetColorizationColor` is documented.** It returns glass-composition color in `0xAARRGGBB`, plus an opaque-blend flag. It does not return a `COLORREF` (`0x00BBGGRR`). Listening for `WM_DWMCOLORIZATIONCOLORCHANGED` is documented too. These values can inform matching legacy window chrome, but they do not establish the modern control accent ramp or a window's final composited pixels. [DWM getter](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmgetcolorizationcolor), [DWM notification](https://learn.microsoft.com/en-us/windows/win32/dwm/wm-dwmcolorizationcolorchanged).

```cpp
#include <windows.h>
#include <dwmapi.h>
// Link Dwmapi.lib; failure means no usable color was obtained.
DWORD argb = 0;
BOOL opaque = FALSE;
HRESULT hr = DwmGetColorizationColor(&argb, &opaque);
if (SUCCEEDED(hr)) {
    BYTE r = BYTE(argb >> 16), g = BYTE(argb >> 8), b = BYTE(argb);
    // Consume r/g/b; retain alpha and opaque if composition matters.
}
```

Rust has a generated `windows::Win32::Graphics::Dwm` projection with feature `Win32_Graphics_Dwm`; the native API contract above remains the relevant stability guarantee.

**`DwmGetColorizationParameters` is the private route.** Historical source dynamically resolves colorization getter/setter exports and manually declares their parameter structures. That is evidence of a technique, not a supported Windows 11 ABI. Published ordinal recipes should not be treated as universal identifiers. No current-build ordinal, signature, or availability was established here, so no claimed working Windows 11 FFI sample is supplied. [Original implementation source](https://github.com/vhanla/StartScreenCustomizer/blob/main/ModernUIStartScreen_src.pas).

Private UxTheme routines form another historical path: `GetImmersiveUserColorSetPreference`, `GetImmersiveColorTypeFromName`, and `GetImmersiveColorFromColorSetEx`. The authored example resolves immersive names and returns packed colors with low-byte red, unlike DWM's ARGB layout. Names such as an immersive system accent and its variants must be verified on the target build; hardcoded indices, ordinals and high-contrast policy arguments are unstable. There is no supported `windows` projection for these private declarations. [Original immersive-color implementation](https://gist.github.com/anaisbetts/3c6aedc9f0cd39a77c37).

`DWMWA_USE_IMMERSIVE_DARK_MODE`, `DWMWA_BORDER_COLOR`, and `DWMWA_CAPTION_COLOR` concern window-frame policy or per-window color overrides. They are not alternative getters for the user's base accent. Defaults, focus state, and application overrides can make a border/title bar differ from that accent. [DWM window attributes](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute).

## 5. Registry catalog: colors, flags, and legacy values

Use the interactive user's hive. A service or process running under another account must not assume its `HKCU` belongs to the person viewing the UI. Read the expected type, handle missing values, and distinguish “unavailable” from black or zero. `RegGetValueW` supports type restrictions; `RegNotifyChangeKeyValue` can notify about storage changes but does not turn that storage into a supported theming contract. [Registry reads](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-reggetvaluew), [change notifications](https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regnotifychangekeyvalue).

Paths below are relative to `HKEY_CURRENT_USER`:

| Path | Values and interpretation | Confidence / dark-light caveat |
| --- | --- | --- |
| `Software\Microsoft\Windows\DWM` | `AccentColor`, `ColorizationColor`; legacy `ColorizationAfterglow`, `ColorizationColorBalance`, `ColorizationAfterglowBalance`, `ColorizationBlurBalance`, `ColorizationGlassAttribute`; `ColorPrevalence`, `EnableWindowColorization` | Microsoft protocol documentation explicitly maps these names to this key. Balance/enable/prevalence fields are not RGB values. These describe composition state, not two complete light/dark palettes. |
| `Software\Microsoft\Windows\CurrentVersion\Explorer\Accent` | `AccentColorMenu`, `StartColorMenu`, `AccentPalette` | Also mapped by Microsoft's protocol documentation. Palette data is storage, not a promised fixed-offset `UIColorType` array. Do not infer a Windows 11 layout from a Windows 8/10 recipe. |

The source for those mappings is Microsoft's [TS_ACCENTCOLOR protocol structure](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdperp/bc6975ee-c630-4414-ba10-04eecbb6fccc). This verifies the names/locations; it does not define a general local application accent API or establish all current storage encodings.

Additional observed storage and legacy paths:

| Path | Values | Status / gotcha |
| --- | --- | --- |
| `Software\Microsoft\Windows\DWM` | Optional `AccentColorInactive` | Inactive frame override used by customization tools; may be absent. It is not the user's general accent. |
| `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` | `ColorPrevalence`, `AppsUseLightTheme`, `SystemUsesLightTheme` | Observed shell/application theme preferences and accent-application toggle. These are flags, not colors; app mode and shell mode can differ. |
| `Control Panel\Colors` | `Hilight`, `HilightText`, `HotTrackingColor`, `ActiveTitle`, `Window`, `WindowText`, etc. | Classic semantic palette; strings use decimal `R G B` components. Useful context for contrast themes, not a reliable modern accent getter. |
| `Control Panel\Desktop\Colors` | A mirror path mentioned in some customization recipes | No authoritative Windows 11 accent schema was established for this path. Do not make it a production fallback merely because a recipe mentions it. |

An authored customization file shows the DWM/Explorer/Personalize fields and illustrates different packed layouts for `AccentColor` versus `ColorizationColor`; it is Windows 10-era implementation evidence, not a Windows 11 guarantee. [Original registry customization source](https://github.com/jelbo/Windows10Tweaks/blob/master/Tweaks%20Collection.reg). The classic palette and RGB string convention are documented in Microsoft's [theme-file format](https://learn.microsoft.com/en-us/windows/win32/controls/themesfileformat-overview).

**Spelling and location correction:** the verified value is `ColorPrevalence`, not `ColorPrecedence`. Modern accent DWORDs above live under `Software\Microsoft\...`; no supported `HKCU\Control Panel\...\ColorPrecedence` accent contract was established. A prevalence value says where color is applied, not which color was selected.

Raw storage-read illustration, returning a DWORD without pretending its layout is ARGB:

```cpp
#include <windows.h>
DWORD stored = 0, bytes = sizeof(stored);
LSTATUS status = RegGetValueW(
    HKEY_CURRENT_USER,
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Accent",
    L"AccentColorMenu", RRF_RT_REG_DWORD, nullptr, &stored, &bytes);
if (status == ERROR_SUCCESS) {
    // Validate the encoding on the target build before converting to CSS RGB.
}
```

Common observed `AccentColor`/`AccentColorMenu` recipes use `0xAABBGGRR`; DWM's documented getter uses `0xAARRGGBB`. On little-endian Windows, DWORD display order and raw byte order also differ. Never apply one decoder to every value. Prefer WinRT's explicit channels over relying on these storage conventions.

Saved `.theme` files can contain `[VisualStyles] ColorizationColor` and classic color sections. Parsing a theme file yields saved configuration, not proof of the current live accent after personalization changes. It is an inspection source, not the recommended runtime read path. [Theme-file format](https://learn.microsoft.com/en-us/windows/win32/controls/themesfileformat-overview).

## 6. Classic colors and high-contrast mode

`GetSysColor(COLOR_HIGHLIGHT)` and `GetThemeSysColor`/`UIElementColor` queries answer semantic system-color questions. They should not be relabeled as an exact Windows 11 accent. Many classic color indices are explicitly unsupported on Windows 10 and later. Use role pairs such as highlight/highlight-text when implementing the corresponding contrast-theme role. [GetSysColor contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getsyscolor).

Detect contrast themes with `AccessibilitySettings.HighContrast` and its change notification, or Win32's `SPI_GETHIGHCONTRAST`. Under contrast themes, prioritize the effective user-selected semantic palette over a custom accent ramp. A successfully read accent value does not establish that it should replace text, background, or selection colors. [HighContrast property](https://learn.microsoft.com/en-us/uwp/api/windows.ui.viewmanagement.accessibilitysettings.highcontrast?view=winrt-26100), [Windows forced-colors guidance](https://learn.microsoft.com/en-us/fluent-ui/web-components/design-system/high-contrast).

C++ illustration: retain the query's success separately from the contrast flag; these colors represent selection roles, not the base accent. [SystemParametersInfoW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfow).

```cpp
#include <windows.h>
HIGHCONTRASTW hc{sizeof(HIGHCONTRASTW)};
BOOL known = SystemParametersInfoW(SPI_GETHIGHCONTRAST, sizeof(hc), &hc, 0);
bool contrast = known && (hc.dwFlags & HCF_HIGHCONTRASTON);
COLORREF selection = GetSysColor(COLOR_HIGHLIGHT);
COLORREF selectionText = GetSysColor(COLOR_HIGHLIGHTTEXT);
```

## 7. WebView2 and CSS: useful controls, no exact-accent shortcut

| Lever | Effect | Accent-reading limitation |
| --- | --- | --- |
| `ICoreWebView2Profile::PreferredColorScheme` | `Auto`, `Light`, or `Dark`; affects profile-associated WebViews, dialogs/prompts/menus and `prefers-color-scheme`. Auto follows the OS. | Scheme preference is not accent RGB. A shared profile setting can affect more than one WebView. |
| CSS `color-scheme: light dark` or an explicit scheme | Lets browser-rendered form controls, scrollbars and other special UI use the selected scheme. | Does not reveal the native accent or automatically recolor arbitrary app CSS. |
| CSS `accent-color` | Sets the accent for applicable browser controls; `auto` delegates to the user agent. | This is a rendering instruction, not an OS accent getter. An app-set value is an app override. |
| CSS system colors `AccentColor`, `AccentColorText`, `Highlight`, etc. | Browser-defined system/semantic colors; can be inspected through computed styles where supported. | CSS permits fixed values rather than the user's personalized values. Feature support is not proof of equality to `UISettings`. |
| `matchMedia('(forced-colors: active)')` and semantic CSS colors | Exposes forced-colors mode for contrast-theme-aware rendering. | High-contrast selection colors need not equal the ordinary personalization accent. |

Sources: [WebView2 profile API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile), [CSS color-scheme](https://drafts.csswg.org/css-color-adjust-1/#color-scheme-prop), [CSS accent-color](https://drafts.csswg.org/css-ui-4/#widget-accent), [CSS system colors](https://drafts.csswg.org/css-color-4/#css-system-colors).

C++ host illustration with an existing `ICoreWebView2* view`: negotiate the profile interface, then request OS-following scheme. This changes profile behavior; it does not read an accent. Retain and handle the final `HRESULT`. [Profile access](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_13).

```cpp
#include <WebView2.h>
#include <wrl/client.h>
Microsoft::WRL::ComPtr<ICoreWebView2_13> view13;
Microsoft::WRL::ComPtr<ICoreWebView2Profile> profile;
HRESULT hr = view->QueryInterface(IID_PPV_ARGS(&view13));
if (SUCCEEDED(hr)) hr = view13->get_Profile(&profile);
if (SUCCEEDED(hr))
    hr = profile->put_PreferredColorScheme(COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO);
```

Chromium/WebView2 versions may differ in system-color support and native-widget painting. An HTML sample that happens to match one machine's accent is an observation for that runtime/build, not a portable native-read guarantee. The reviewed public WebView2 profile reference exposes scheme selection, not an accent RGB property. Use the host bridge when exact Windows personalization is required.

## 8. Verification limits and integration checks

This is a documentation/source digest. No Windows API call, registry query, private-export resolution, event observation, browser render, or sample compilation was performed for C4. The Rust helper follows the published Microsoft `windows` 0.62.2 method names; adding a dependency or changing the project's feature list is outside this chunk.

Before adopting an implementation, record the Windows 11 build and WebView2 version, and compare manual/automatic accent selection in light, dark, and contrast themes. Check changes without restart, theme changes after wallpaper changes, explicit app theme/accent overrides, missing settings, correct user/session identity, and shutdown event cleanup. Validate color channel order using a deliberately asymmetric RGB color. Keep these observations separate from the supported API contract.

## Recommended pick for Tauri v2

Use a narrow Rust command backed by **`UISettings.GetColorValue(UIColorType::Accent)` plus the six accent shades**; return numeric RGBA channels to the frontend. Keep one settings instance and a revocable `ColorValuesChanged` registration, then deliver refreshed data through a Tauri event after handling thread ownership. Preserve explicit app theme/accent choices, use semantic system colors in contrast mode, and report an unavailable read rather than inventing a black accent. Tauri documents the [Rust-command bridge](https://v2.tauri.app/develop/calling-rust/) and [frontend event delivery](https://v2.tauri.app/develop/calling-frontend/).

This pick provides a documented palette without private ordinals, registry-layout assumptions, or browser-color inference. Use WebView2's preferred scheme and CSS `color-scheme` alongside it for native-widget light/dark consistency; those settings complement the accent read and do not replace it.
