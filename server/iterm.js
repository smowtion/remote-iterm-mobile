const { exec } = require('child_process');

const runAppleScript = (script) => {
    return new Promise((resolve, reject) => {
        exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.trim());
        });
    });
};

// The live stream asks for this many characters: enough to cover a whole
// typical scrollback, so the phone can scroll natively like iTerm does.
const DEFAULT_CONTENT_CHARS = 12000;
const MAX_CONTENT_CHARS = 200000;

// Decode JS-style escapes (\x1b, \n, \r, \t, \\) into raw characters so the
// phone can send real key sequences instead of literal "\x1b" text.
function decodeEscapes(input) {
    return String(input).replace(/\\(x[0-9a-fA-F]{2}|[nrt0\\])/g, (match, seq) => {
        if (seq[0] === 'x') return String.fromCharCode(parseInt(seq.slice(1), 16));
        if (seq === 'n') return '\n';
        if (seq === 'r') return '\r';
        if (seq === 't') return '\t';
        if (seq === '0') return '\0';
        return '\\';
    });
}

// Build an AppleScript expression that produces the exact characters.
// Printable runs stay quoted; control chars (ESC, Ctrl-C, ...) become
// `character id N` so AppleScript cannot mangle or reinterpret them.
function toAppleScriptString(text) {
    const parts = [];
    let buf = '';
    for (const ch of text) {
        const code = ch.codePointAt(0);
        if (code >= 32 && code !== 39 && code !== 92) {
            buf += ch;
            continue;
        }
        if (buf) { parts.push(`"${buf}"`); buf = ''; }
        parts.push(`(character id ${code})`);
    }
    if (buf) parts.push(`"${buf}"`);
    return parts.length ? parts.join(' & ') : '""';
}

const iterm = {
    // Get all windows, tabs, and sessions
    getState: async () => {
        const script = `
            set output to ""
            tell application "iTerm"
                try
                    set winCount to count of windows
                    repeat with wIdx from 1 to winCount
                        set w to window wIdx
                        set winId to (id of w) as string
                        set isF to (frontmost of w) as string
                        try
                            set b to bounds of w
                            set output to output & "W:" & winId & ":" & isF & ":" & (item 1 of b) & ":" & (item 2 of b) & ":" & (item 3 of b) & ":" & (item 4 of b) & "\\n"
                        on error
                            set output to output & "W:" & winId & ":" & isF & ":0:0:800:600\\n"
                        end try
                        
                        try
                            set tabCount to count of tabs of w
                            set ct to current tab of w
                            repeat with tIdx from 1 to tabCount
                                set t to tab tIdx of w
                                if t is ct then
                                    set isS to "true"
                                else
                                    set isS to "false"
                                end if
                                set output to output & "T:" & tIdx & ":" & winId & "-" & tIdx & ":" & isS & "\\n"

                                try
                                    set sessCount to count of sessions of t
                                    repeat with sIdx from 1 to sessCount
                                        set s to session sIdx of t
                                        set sessId to (id of s) as string
                                        set sessName to (name of s) as string
                                        set output to output & "S:" & sessId & ":" & sessName & "\\n"
                                    end repeat
                                on error
                                end try
                            end repeat
                        on error
                        end try
                    end repeat
                on error errMsg
                    set output to "ERROR:" & errMsg
                end try
            end tell
            return output
        `;
        try {
            const result = await runAppleScript(script);
            if (result.startsWith('ERROR:')) return [];
            return parseState(result);
        } catch (err) {
            return [];
        }
    },

    // Get content of a specific session.
    // `maxChars` controls how much scrollback comes back: the live stream asks
    // for a small tail, while "load older messages" asks for the whole buffer.
    getContent: async (sessionId, maxChars = DEFAULT_CONTENT_CHARS) => {
        const limit = Math.max(1, Math.min(MAX_CONTENT_CHARS, Math.floor(maxChars) || DEFAULT_CONTENT_CHARS));
        let script = '';
        if (sessionId && sessionId !== 'undefined') {
            script = `
                tell application "iTerm"
                    try
                        repeat with w in windows
                            repeat with t in tabs of w
                                repeat with s in sessions of t
                                    if ((id of s) as string) is "${sessionId}" then
                                        set cont to contents of s
                                        if (count of cont) > ${limit} then
                                            return text -${limit} thru -1 of cont
                                        else
                                            return cont
                                        end if
                                    end if
                                end repeat
                            end repeat
                        end repeat
                    on error
                    end try
                    set cont to contents of current session of current window
                    if (count of cont) > ${limit} then
                        return text -${limit} thru -1 of cont
                    else
                        return cont
                    end if
                end tell
            `;
        } else {
            script = `
                tell application "iTerm"
                    set cont to contents of current session of current window
                    if (count of cont) > ${limit} then
                        return text -${limit} thru -1 of cont
                    else
                        return cont
                    end if
                end tell
            `;
        }

        try {
            return await runAppleScript(script);
        } catch (err) {
            return "";
        }
    },

    executeCommand: async (sessionId, command) => {
        let script = '';
        if (sessionId && sessionId !== 'undefined') {
            script = `
                tell application "iTerm"
                    try
                        repeat with w in windows
                            repeat with t in tabs of w
                                repeat with s in sessions of t
                                    if ((id of s) as string) is "${sessionId}" then
                                        tell s to write text "${command.replace(/"/g, '\\"')}"
                                        return "OK"
                                    end if
                                end repeat
                            end repeat
                        end repeat
                    on error
                    end try
                    tell current session of current window to write text "${command.replace(/"/g, '\\"')}"
                end tell
            `;
        } else {
            script = `tell application "iTerm" to tell current session of current window to write text "${command.replace(/"/g, '\\"')}"`;
        }
        return runAppleScript(script);
    },

    newTab: async (windowId) => {
        if (windowId) {
            const script = `
                tell application "iTerm"
                    repeat with w in windows
                        if ((id of w) as string) is "${windowId}" then
                            tell w to create tab with default profile
                            exit repeat
                        end if
                    end repeat
                end tell
            `;
            return runAppleScript(script);
        }
        return runAppleScript(`tell application "iTerm" to tell current window to create tab with default profile`);
    },

    switchTab: async (direction) => {
        const script = `
            tell application "iTerm"
                tell current window
                    set tabCount to count of tabs
                    set ct to current tab
                    repeat with i from 1 to tabCount
                        if tab i is ct then
                            if "${direction}" is "next" then
                                set newIdx to (i mod tabCount) + 1
                            else
                                set newIdx to ((i - 2 + tabCount) mod tabCount) + 1
                            end if
                            select tab newIdx
                            exit repeat
                        end if
                    end repeat
                end tell
            end tell
        `;
        return runAppleScript(script);
    },

    closeTab: async () => {
        const script = `
            tell application "iTerm"
                tell current session of current window
                    close
                end tell
            end tell
        `;
        return runAppleScript(script);
    },

    focus: async (windowId, tabIndex) => {
        if (!windowId) return;
        const script = `
            tell application "iTerm"
                activate
                repeat with w in windows
                    if ((id of w) as string) is "${windowId}" then
                        select w
                        if ${tabIndex} is not 0 then
                            select tab ${tabIndex} of w
                        end if
                        exit repeat
                    end if
                end repeat
            end tell
        `;
        return runAppleScript(script);
    },

    // Set iTerm tab color via escape sequences written to session TTY
    setTabColor: async (sessionId, r, g, b) => {
        if (!sessionId || sessionId === 'undefined') return;
        const script = `
            tell application "iTerm"
                try
                    repeat with w in windows
                        repeat with t in tabs of w
                            repeat with s in sessions of t
                                if ((id of s) as string) is "${sessionId}" then
                                    set ttyPath to tty of s
                                    do shell script "printf '\\\\033]6;1;bg;red;brightness;${r}\\\\007\\\\033]6;1;bg;green;brightness;${g}\\\\007\\\\033]6;1;bg;blue;brightness;${b}\\\\007' > " & ttyPath
                                    return
                                end if
                            end repeat
                        end repeat
                    end repeat
                on error
                end try
            end tell
        `;
        return runAppleScript(script);
    },

    // Send raw text/escape sequences to a session (for Ctrl+C, arrow keys, etc.)
    sendKeys: async (sessionId, keys) => {
        const target = (sessionId && sessionId !== 'undefined')
            ? `
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            if ((id of s) as string) is "${sessionId}" then
                                tell s to write text "${keys}" newline NO
                                return
                            end if
                        end repeat
                    end repeat
                end repeat
                tell current session of current window to write text "${keys}" newline NO
            `
            : `tell current session of current window to write text "${keys}" newline NO`;

        const script = `tell application "iTerm"\n${target}\nend tell`;
        return runAppleScript(script);
    },

    // Send decoded control sequences (ESC, Ctrl-C, PageUp/PageDown, arrows...).
    // `repeat` lets the client send N keypresses in one AppleScript round-trip.
    sendControl: async (sessionId, keys, repeat = 1) => {
        const text = decodeEscapes(keys).repeat(Math.max(1, Math.min(50, Math.floor(repeat) || 1)));
        if (!text) return;
        const expr = toAppleScriptString(text);
        const target = (sessionId && sessionId !== 'undefined')
            ? `
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            if ((id of s) as string) is "${sessionId}" then
                                tell s to write text (${expr}) newline NO
                                return
                            end if
                        end repeat
                    end repeat
                end repeat
                tell current session of current window to write text (${expr}) newline NO
            `
            : `tell current session of current window to write text (${expr}) newline NO`;

        return runAppleScript(`tell application "iTerm"\n${target}\nend tell`);
    },

    getScreenSize: async () => {
        try {
            const result = await runAppleScript(`tell application "Finder" to get bounds of window of desktop`);
            const parts = result.split(',').map(s => parseInt(s.trim()));
            return { width: parts[2] || 1470, height: parts[3] || 956 };
        } catch {
            return { width: 1470, height: 956 };
        }
    },

    renameSession: async (sessionId, name) => {
        if (!sessionId || sessionId === 'undefined') return;
        const safeName = name.replace(/"/g, '\\"');
        const script = `
            tell application "iTerm"
                try
                    repeat with w in windows
                        repeat with t in tabs of w
                            repeat with s in sessions of t
                                if ((id of s) as string) is "${sessionId}" then
                                    set name of s to "${safeName}"
                                    return "OK"
                                end if
                            end repeat
                        end repeat
                    end repeat
                on error
                end try
            end tell
        `;
        return runAppleScript(script);
    }
};

function parseState(raw) {
    if (!raw) return [];
    const lines = raw.split('\n');
    const state = [];
    let currentWindow = null;
    let currentTab = null;

    lines.forEach(line => {
        if (line.startsWith('W:')) {
            const parts = line.substring(2).split(':');
            const bounds = parts.length >= 6 ? {
                x: parseInt(parts[2]) || 0,
                y: parseInt(parts[3]) || 0,
                w: (parseInt(parts[4]) || 800) - (parseInt(parts[2]) || 0),
                h: (parseInt(parts[5]) || 600) - (parseInt(parts[3]) || 0),
            } : { x: 0, y: 0, w: 800, h: 600 };
            currentWindow = { id: parts[0].trim(), isFront: parts[1] === 'true', tabs: [], bounds };
            state.push(currentWindow);
        } else if (line.startsWith('T:')) {
            const parts = line.substring(2).split(':');
            currentTab = { index: parseInt(parts[0]), id: parts[1], isSelected: parts[2] === 'true', sessions: [] };
            if (currentWindow) currentWindow.tabs.push(currentTab);
        } else if (line.startsWith('S:')) {
            const parts = line.substring(2).split(':');
            const session = { id: parts[0], name: parts.slice(1).join(':').trim() };
            if (currentTab) currentTab.sessions.push(session);
        }
    });
    return state;
}

module.exports = iterm;
