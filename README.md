# remote-iterm-mobile

[![Sponsor](https://img.shields.io/badge/sponsor-ipdata.info-10b981?style=flat-square)](https://ipdata.info)

Drive iTerm2 from your phone over your local network — a mobile-first remote with real scrollback, TUI paging, split view, and a cleaned-up OpenCode view.

## Why this app

On a phone the terminal used to feel like a static screenshot: no history, no scrolling inside full-screen apps, and OpenCode's progress bars ate the screen. This rebuild fixes that.

| | |
|---|---|
| **Read old output** | Scroll up in a shell and the full buffer is fetched on demand (up to 120k chars), anchored so your view does not jump. |
| **Scroll inside TUIs** | OpenCode, vim, less and tmux draw their own viewport — no terminal scrollback exists. The app sends real `PageUp` / `PageDown` keys to the pty, so swipes and the `PgUp` / `PgDn` buttons page the app itself. |
| **Return to live** | One tap on **↓** pages the remote app back to the newest message and resumes streaming. |
| **Clean OpenCode** | Strips progress bars, box borders, token/cost footers, `Thought · …ms` badges and `Press ctrl+b…` hints. Toggle with **`OC✓`**. |
| **Readable by default** | Font size cycling (**`Aa`**), wrap / no-wrap (**`Wrap`**), color-preserving ANSI rendering. |

## Features

- Live terminal mirror, refreshed every 150 ms, ANSI colors preserved.
- Scrollback: a light live tail while streaming, the full buffer when you scroll up.
- Remote paging for alternate-screen apps (PageUp / PageDown), with swipe gestures.
- Floating **↓** button whenever you are reading history.
- Tab bar with create / close / long-press rename, pinned on the right.
- Multi-window picker with a spatial map of your Mac's displays and windows.
- Split view — two tabs side by side (or stacked in portrait), each with its own tab bar.
- Broadcast — send one command to the active tab of several windows at once.
- Quick keys: arrows, `PgUp` / `PgDn`, `TAB`, `Enter`, `Ctrl-C`, `Ctrl-D`, `Esc`.
- Working touch scroll that no longer fights auto-scroll.
- Reliable `stop` that kills the node / Vite listeners on 7291 and 7292.

## Requirements

- macOS with iTerm2
- Node.js >= 18
- Phone on the same LAN (or a private VPN such as Tailscale / WireGuard)

## Install

### From GitHub

```bash
npm install -g github:smowtion/remote-iterm-mobile
remote-iterm
```

### From source

```bash
git clone https://github.com/smowtion/remote-iterm-mobile.git
cd remote-iterm-mobile
npm install
./iterm-server start
```

The first run asks macOS for **Automation** permission so the app can control iTerm2 and Finder. Allow it in **System Settings → Privacy & Security → Automation**.

## Usage

1. Open iTerm2.
2. Start the app:

   ```bash
   remote-iterm
   ```

3. A QR code and URL are printed, for example `http://192.168.1.20:7292`.
4. Scan the QR or open the URL on your phone, then **Add to Home Screen** for a full-screen experience.

### Commands

```bash
remote-iterm          # start server (7291) + UI (7292)
remote-iterm stop     # stop both
remote-iterm restart  # restart both
```

### Reading older output

- **Shell with scrollback** — drag down past the top (or drag up, then keep pulling). The full buffer is loaded once and your position is kept.
- **Full-screen app (OpenCode / vim / less / tmux)** — the same gesture sends `PageUp` to the app; `PgDn` and the **↓** button send `PageDown` until you are back at the newest output.
- **Buttons** — `PgUp` / `PgDn` in the quick-key row do the same thing without gestures.
- **Back to live** — tap **↓** (or scroll to the bottom of the loaded history).

### Tabs, split view, broadcast

- **Tab bar** — tap a tab to focus it on the Mac, `+` to create, `X` to close the current one, long-press (~0.5 s) to rename.
- **Multiple windows** — tap the `N win` button and pick a window from the spatial map.
- **Split view** — tap the split icon to show two tabs; tap a pane to choose where commands go. The focused pane drives `PgUp`, the quick keys and **↓**.
- **Broadcast** — tap the radio icon, pick target windows, then send one command to every selected window's active tab.
- **Readability** — `Aa` cycles font size (12 / 13 / 14 / 16 / 18 px, remembered), `OC✓` toggles OpenCode cleaning, `Wrap` toggles line wrapping.

## Ports

| Port | Service |
|---|---|
| `7291` | Socket.IO server (state, streaming, key input) |
| `7292` | Vite dev server (the UI) |

## Security warning

**There is no authentication.** Anyone who can reach port 7291 or 7292 can read your terminal and run commands as your macOS user.

- Use it only on a network you trust.
- Never port-forward 7291 / 7292 to the internet.
- Prefer a private VPN (Tailscale / WireGuard) for remote access — and remember that any VPN peer can then control the terminal.
- Stop it when finished:

  ```bash
  remote-iterm stop
  ```

## Troubleshooting

- **White page** — hard reload. If it persists, clear the Vite cache and restart:

  ```bash
  remote-iterm stop
  rm -rf client/node_modules/.vite
  remote-iterm
  ```

- **Phone cannot connect** — confirm both devices are on the same network, iOS Local Network permission is granted, and the Mac firewall is not blocking Node.
- **No tabs or windows** — open iTerm2 and grant Automation permission.
- **Old output missing in a TUI** — that app owns its viewport; use `PgUp` (or swipe down at the top) rather than expecting terminal scrollback.
- **Logs** — `.iterm-server.log` in the package directory.
- **Diagnostics** — `node server/diag.js` prints the detected windows / tabs / sessions.

## Development

```bash
cd client && npm run dev      # UI only, port 7292
cd server && node index.js    # API only, port 7291
cd client && npm run build    # type-check + production bundle
```

## Changelog

### 1.2.0

- Scrollback support: on-demand full-buffer fetch with scroll anchoring.
- Remote paging (`PageUp` / `PageDown`) for alternate-screen apps such as OpenCode, vim, less and tmux.
- Swipe gestures for history and paging, plus `PgUp` / `PgDn` quick keys.
- **↓** now restores both the live tail and the remote app's newest page.
- Fixed quick-action keys that were typed as literal `\xNN` text instead of control bytes.

### 1.1.0

- Mobile UI rework, OpenCode output cleaning, split view, broadcast, window map.
- Reliable `stop`, touch-scroll fixes, Vite 5.4 white-screen fix.

## Sponsor

If this saves you a trip back to your Mac, you can support the work here: **[ipdata.info](https://ipdata.info)**.

## Credits

Built and maintained by [Smowtion](https://github.com/smowtion). Mobile UI, scrollback and TUI paging by the same author. MIT licensed.

## License

MIT — see [LICENSE](LICENSE).

---

## Hướng dẫn nhanh (Tiếng Việt)

```bash
npm install -g github:smowtion/remote-iterm-mobile
remote-iterm
```

- Mở iTerm2 trước khi chạy.
- Điện thoại kết nối **cùng Wi-Fi**, mở `http://<IP-Mac>:7292` (hoặc quét QR).
- **Đọc output cũ:** kéo xuống khi đang ở đầu trang → tải toàn bộ scrollback. Với app toàn màn hình (OpenCode, vim, less, tmux) thao tác này gửi `PageUp`; dùng `PgDn` hoặc nút **↓** để về mới nhất.
- **`Aa`**: đổi cỡ chữ. **`OC✓`**: bật/tắt lọc progress/status bar của OpenCode. **`Wrap`**: bật/tắt xuống dòng.
- Tắt khi không dùng:

  ```bash
  remote-iterm stop
  ```

**Cảnh báo:** app không có mật khẩu. Chỉ dùng trên Wi-Fi tin cậy, không mở port 7291/7292 ra internet.
