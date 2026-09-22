import { execFile } from 'child_process';
import { promisify } from 'util';
import type { BrowserWindow } from 'electron';

const runFile = promisify(execFile);

// Electron sets one X11 WM_CLASS for the Hub process. Give each Q-App window
// the class declared by its desktop entry before the window is shown.
const setClassScript = `import ctypes
import sys

x11 = ctypes.CDLL('libX11.so.6')
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XInternAtom.restype = ctypes.c_ulong
x11.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]

display = x11.XOpenDisplay(None)
if not display:
    sys.exit(1)
name = sys.argv[2].encode('ascii')
value = ctypes.create_string_buffer(name + b'\\0' + name + b'\\0')
x11.XChangeProperty(display, int(sys.argv[1]), x11.XInternAtom(display, b'WM_CLASS', 0), x11.XInternAtom(display, b'STRING', 0), 8, 0, value, len(value.raw) - 1)
x11.XFlush(display)
x11.XCloseDisplay(display)
`;

export async function setQAppX11WindowClass(
  window: BrowserWindow,
  wmClass: string
): Promise<void> {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return;
  const handle = window.getNativeWindowHandle();
  if (handle.length < 4) return;
  await runFile('python3', [
    '-c',
    setClassScript,
    String(handle.readUInt32LE(0)),
    wmClass,
  ]);
}
