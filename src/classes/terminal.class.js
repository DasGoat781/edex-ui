class Terminal {
    constructor(opts) {
        if (opts.role === "client") {
            if (!opts.parentId) throw "Missing options";

            this.xTerm = require("xterm").Terminal;
            this.Ipc = require("electron").ipcRenderer;

            this.port = opts.port || 3000;
            this.cwd = "";
            this.oncwdchange = () => {};

            let attachAddon = require("./node_modules/xterm/lib/addons/attach/attach.js");
            let fitAddon = require("./node_modules/xterm/lib/addons/fit/fit.js");
            this.xTerm.applyAddon(attachAddon);
            this.xTerm.applyAddon(fitAddon);

            this._sendSizeToServer = () => {
                let cols = this.term.cols.toString();
                let rows = this.term.rows.toString();
                while (cols.length < 3) {
                    cols = "0"+cols;
                }
                while (rows.length < 3) {
                    rows = "0"+rows;
                }
                this.Ipc.send("terminal_channel-"+this.port, "Resize", cols, rows);
            };

            let color = require("color");
            let colorify = (base, target) => {
                return color(base).grayscale().mix(color(target), 0.3).hex();
            };
            let themeColor = `rgb(${window.theme.r}, ${window.theme.g}, ${window.theme.b})`;

            this.term = new this.xTerm({
                cols: 80,
                rows: 24,
                cursorBlink: window.theme.terminal.cursorBlink || true,
                cursorStyle: window.theme.terminal.cursorStyle || "block",
                allowTransparency: window.theme.terminal.allowTransparency || false,
                fontFamily: window.theme.terminal.fontFamily || "Fira Mono",
                fontSize: window.theme.terminal.fontSize || 15,
                fontWeight: window.theme.terminal.fontWeight || "normal",
                fontWeightBold: window.theme.terminal.fontWeightBold || "bold",
                letterSpacing: window.theme.terminal.letterSpacing || 0,
                lineHeight: window.theme.terminal.lineHeight || 1,
                scrollback: 1500,
                bellStyle: "none",
                theme: {
                    foreground: window.theme.terminal.foreground,
                    background: window.theme.terminal.background,
                    cursor: window.theme.terminal.cursor,
                    cursorAccent: window.theme.terminal.cursorAccent,
                    selection: window.theme.terminal.selection,
                    black: window.theme.colors.black || colorify("#2e3436", themeColor),
                    red: window.theme.colors.red || colorify("#cc0000", themeColor),
                    green: window.theme.colors.green || colorify("#4e9a06", themeColor),
                    yellow: window.theme.colors.yellow || colorify("#c4a000", themeColor),
                    blue: window.theme.colors.blue || colorify("#3465a4", themeColor),
                    magenta: window.theme.colors.magenta || colorify("#75507b", themeColor),
                    cyan: window.theme.colors.cyan || colorify("#06989a", themeColor),
                    white: window.theme.colors.white || colorify("#d3d7cf", themeColor),
                    brightBlack: window.theme.colors.brightBlack || colorify("#555753", themeColor),
                    brightRed: window.theme.colors.brightRed || colorify("#ef2929", themeColor),
                    brightGreen: window.theme.colors.brightGreen || colorify("#8ae234", themeColor),
                    brightYellow: window.theme.colors.brightYellow || colorify("#fce94f", themeColor),
                    brightBlue: window.theme.colors.brightBlue || colorify("#729fcf", themeColor),
                    brightMagenta: window.theme.colors.brightMagenta || colorify("#ad7fa8", themeColor),
                    brightCyan: window.theme.colors.brightCyan || colorify("#34e2e2", themeColor),
                    brightWhite: window.theme.colors.brightWhite || colorify("#eeeeec", themeColor)
                }
            });
            this.term.open(document.getElementById(opts.parentId));
            this.term.focus();

            this.Ipc.send("terminal_channel-"+this.port, "Renderer startup");
            this.Ipc.on("terminal_channel-"+this.port, (e, ...args) => {
                switch(args[0]) {
                    case "New cwd":
                        this.cwd = args[1];
                        this.oncwdchange();
                        break;
                    default:
                        return;
                }
            });

            let sockHost = opts.host || "127.0.0.1";
            let sockPort = this.port;

            this.socket = new WebSocket("ws://"+sockHost+":"+sockPort);
            this.socket.onopen = () => {
                this.term.attach(this.socket);
                this.fit();
                setTimeout(() => {
                    this.fit();
                }, 200);
            };
            this.socket.onerror = (e) => {throw e};

            this.fit = () => {
                this.term.fit();
                setTimeout(() => {
                    this.resize(this.term.cols+1, this.term.rows);
                }, 50);
            };

            this.resize = (cols, rows) => {
                this.term.resize(cols, rows);
                this._sendSizeToServer();
            };
        } else if (opts.role === "server") {

            this.Pty = require("node-pty");
            this.Websocket = require("ws").Server;
            this.Ipc = require("electron").ipcMain;

            this.renderer = null;
            this.port = opts.port || 3000;

            this.onclosed = () => {};
            this.onopened = () => {};
            this.onresize = () => {};
            this.ondisconnected = () => {};

            this._getTtyCWD = (tty) => {
                return new Promise((resolve, reject) => {
                    let pid = tty._pid;
                    if (require("os").type() === "Linux") {
                        require("fs").readlink(`/proc/${pid}/cwd`, (e, cwd) => {
                            if (e !== null) {
                                reject(e);
                            } else {
                                resolve(cwd);
                            }
                        });
                    } else {
                        reject("Unsupported OS");
                    }
                });
            };
            this._nextTickUpdateTtyCWD = false;
            this._tick = setInterval(() => {
                if (this._nextTickUpdateTtyCWD) {
                    this._nextTickUpdateTtyCWD = false;
                    this._getTtyCWD(this.tty).then(cwd => {
                        if (this.tty._cwd === cwd) return;
                        this.tty._cwd = cwd;
                        if (this.renderer) {
                            this.renderer.send("terminal_channel-"+this.port, "New cwd", cwd);
                        }
                    }).catch(e => {
                        console.log("Error while tracking TTY working directory: ", e);
                    });
                }
            }, 1000);

            this.tty = this.Pty.spawn(opts.shell || "bash", [], {
                name: 'xterm-color',
                cols: 80,
                rows: 24,
                cwd: opts.cwd || process.env.PWD,
                env: process.env
            });

            this.tty.on('exit', (code, signal) => {
                this.onclosed(code, signal);
            });

            this.wss = new this.Websocket({
                port: this.port,
                clientTracking: true,
                verifyClient: (info) => {
                    if (this.wss.clients.length >= 1) {
                        return false;
                    } else {
                        return true;
                    }
                }
            });
            this.Ipc.on("terminal_channel-"+this.port, (e, ...args) => {
                switch(args[0]) {
                    case "Renderer startup":
                        this.renderer = e.sender;
                        break;
                    case "Resize":
                        let cols = args[1];
                        let rows = args[2];
                        this.tty.resize(Number(cols), Number(rows));
                        this.onresized(cols, rows);
                        break;
                    default:
                        return;
                }
            });
            this.wss.on('connection', (ws) => {
                this.onopened();
                ws.on('message', (msg) => {
                    this.tty.write(msg);
                });
                this.tty.on('data', (data) => {
                    this._nextTickUpdateTtyCWD = true;
                    try {
                        ws.send(data);
                    } catch (e) {
                        // Websocket closed
                    }
                });
            });
            this.wss.on('close', () => {
                this.ondisconnected();
            });
        } else {
            throw "Unknown purpose";
        }
    }
}

module.exports = {
    Terminal
};
