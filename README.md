# remote-iterm-mobile

Control iTerm2 from your phone over your local network — with a mobile-first UI and a cleaner OpenCode view.

This is a fork of [mammadovziya/remote-iterm](https://github.com/mammadovziya/remote-iterm) (MIT), focused on making the terminal comfortable to read and drive on an iPhone-sized screen.

## Mobile improvements

- **Clean OpenCode view** — strips OpenCode progress bars, borders, token/cost footers and `Thought · …ms` badges from the terminal output. Toggle with the **`OC✓`** button.
- **Font size control** — the **`Aa`** button cycles through 12 / 13 / 14 / 16 / 18 px and remembers your choice.
- **Jump to latest output** — when you scroll up, auto-scroll pauses and a floating **↓** button appears. Tap it to jump back to the bottom and resume following output.
- **Working scroll on touch** — dragging up no longer fights the 150 ms auto-scroll.
- **Tabs stay usable** — the `+` / `X` controls are pinned to the right, and long tab names are truncated.
- **Reliable stop** — `remote-iterm stop` now really kills the node/Vite processes listening on 7291/7292.
- **Vite dependency fix** — pre-bundles `debug` and `react-dom/client`, which prevents the white-screen startup issue on Vite 5.4.x.

## Requirements

- macOS with iTerm2
- Node.js >= 18
- Phone on the same local network (or a VPN such as Tailscale/WireGuard)

## Install

### From GitHub (recommended)

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

The first run asks macOS for **Automation** permission so the app can control iTerm2 and Finder. Allow it.

## Usage

1. Open iTerm2.
2. Start the app:

   ```bash
   remote-iterm
   ```

3. Open the printed URL on your phone, for example:

   ```
   http://192.168.1.20:7292
   ```

4. Scan the QR code or open the URL in Safari. Add it to your Home Screen for a full-screen experience.

### Commands

```bash
remote-iterm          # start
remote-iterm stop     # stop
remote-iterm restart  # restart
```

### Tabs, split view and broadcast

- **Tab bar** — tap a tab to focus it on the Mac, `+` to create a tab, `X` to close the current one, long-press (~0.5 s) to rename it.
- **Multiple windows** — tap the `N win` button and pick a window on the spatial map.
- **Split view** — tap the split icon to show two tabs at once; each pane has its own tab bar. Tap a pane to choose where commands go.
- **Broadcast** — tap the radio icon, choose target windows on the map, then send one command to every selected window's active tab.
- **Scroll** — drag up to read history; auto-scroll pauses. Drag back to the bottom, tap the red lock icon, or tap the floating **↓** button to resume.
- **Readability** — tap `Aa` to change the font size; tap `OC✓` to toggle OpenCode output cleaning.

### Ports

- `7291` — Socket.IO server
- `7292` — Vite dev server / UI

## Security warning

**This app has no authentication.** Anyone who can reach port 7291 or 7292 can read your terminal output and execute commands as your macOS user.

Use it only on a network you trust. Do not port-forward 7291/7292 to the internet. Stop it when you are done:

```bash
remote-iterm stop
```

If you need remote access, put the Mac and phone on the same private VPN (Tailscale or WireGuard) rather than exposing the ports publicly. Even then, anyone with a VPN peer can control the terminal.

## Troubleshooting

- **White page** — hard reload the page. If it persists, clear the Vite cache and restart:

  ```bash
  remote-iterm stop
  rm -rf client/node_modules/.vite
  remote-iterm
  ```

- **Phone cannot connect** — make sure both devices are on the same network, iOS Local Network permission is allowed, and the Mac firewall is not blocking Node.
- **No tabs/windows** — open iTerm2 and grant Automation permission in **System Settings → Privacy & Security → Automation**.
- **Logs** — `.iterm-server.log` in the package directory.

## Credits

Based on [mammadovziya/remote-iterm](https://github.com/mammadovziya/remote-iterm), MIT licensed. Mobile UI changes and fixes by [Smowtion](https://github.com/smowtion).

## License

MIT — see [LICENSE](LICENSE).

---

## Hướng dẫn nhanh (Tiếng Việt)

```bash
npm install -g github:smowtion/remote-iterm-mobile
remote-iterm
```

- Mở iTerm2 trước.
- Điện thoại kết nối **cùng Wi-Fi**, mở `http://<IP-Mac>:7292`.
- Kéo lên để đọc output; app tự tạm dừng auto-scroll. Bấm nút **↓** để về cuối.
- **`Aa`**: đổi cỡ chữ. **`OC✓`**: bật/tắt lọc progress/status bar của OpenCode.
- Tắt khi không dùng:

  ```bash
  remote-iterm stop
  ```

**Cảnh báo:** app không có mật khẩu. Chỉ dùng trên Wi-Fi tin cậy, không mở port 7291/7292 ra internet.
