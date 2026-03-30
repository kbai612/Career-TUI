import argparse
import ctypes
import sys
import time
from ctypes import wintypes

try:
    import pyautogui
except ImportError as error:
    sys.stderr.write(
        "pyautogui is required for Career Ops autoapply. "
        "Install it with: python -m pip install pyautogui\n"
    )
    raise SystemExit(2) from error


pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.03

user32 = ctypes.windll.user32


class POINT(ctypes.Structure):
    _fields_ = [("x", wintypes.LONG), ("y", wintypes.LONG)]


def _normalize_title(value: str) -> str:
    return value.strip().lower()


def _enum_windows():
    windows = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value.strip()
        if title:
            windows.append((hwnd, title))
        return True

    user32.EnumWindows(callback, 0)
    return windows


def activate_window(title_hint: str) -> None:
    candidates = []
    for candidate in [title_hint, "LinkedIn", "Google Chrome", "Chrome"]:
        normalized = _normalize_title(candidate)
        if normalized and normalized not in candidates:
            candidates.append(normalized)

    matched_hwnd = None
    for hwnd, title in _enum_windows():
        normalized_title = _normalize_title(title)
        if any(candidate in normalized_title for candidate in candidates):
            matched_hwnd = hwnd
            break

    if matched_hwnd is None:
        return

    user32.SetForegroundWindow(matched_hwnd)
    time.sleep(0.14)


def click(x: int, y: int) -> None:
    pyautogui.click(int(round(x)), int(round(y)))


def click_viewport(x: int, y: int, scale: float) -> None:
    hwnd = user32.GetForegroundWindow()
    if hwnd == 0:
        raise RuntimeError("No foreground window available for viewport click.")
    point = POINT(
        int(round(x * max(0.5, scale))),
        int(round(y * max(0.5, scale)))
    )
    if not user32.ClientToScreen(hwnd, ctypes.byref(point)):
        raise RuntimeError("Unable to convert viewport coordinates to screen coordinates.")
    pyautogui.click(point.x, point.y)


def send_keys(sequence: str) -> None:
    normalized = sequence.strip()
    if not normalized:
      return

    if normalized == "^a":
        pyautogui.hotkey("ctrl", "a")
        return

    token_map = {
        "{BACKSPACE}": "backspace",
        "{DELETE}": "delete",
        "{ENTER}": "enter",
        "{TAB}": "tab",
        "{ESC}": "esc"
    }
    if normalized in token_map:
        pyautogui.press(token_map[normalized])
        return

    pyautogui.write(normalized, interval=0.01)


def type_text(value: str) -> None:
    if not value:
        return
    pyautogui.write(value, interval=0.01)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Career Ops pyautogui bridge")
    subparsers = parser.add_subparsers(dest="command", required=True)

    click_parser = subparsers.add_parser("click")
    click_parser.add_argument("--x", type=int, required=True)
    click_parser.add_argument("--y", type=int, required=True)

    viewport_parser = subparsers.add_parser("click-viewport")
    viewport_parser.add_argument("--x", type=int, required=True)
    viewport_parser.add_argument("--y", type=int, required=True)
    viewport_parser.add_argument("--scale", type=float, default=1.0)

    keys_parser = subparsers.add_parser("send-keys")
    keys_parser.add_argument("--sequence", required=True)

    type_parser = subparsers.add_parser("type-text")
    type_parser.add_argument("--text", required=True)

    activate_parser = subparsers.add_parser("activate-window")
    activate_parser.add_argument("--title-hint", default="")

    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.command == "click":
        click(args.x, args.y)
        return 0
    if args.command == "click-viewport":
        click_viewport(args.x, args.y, args.scale)
        return 0
    if args.command == "send-keys":
        send_keys(args.sequence)
        return 0
    if args.command == "type-text":
        type_text(args.text)
        return 0
    if args.command == "activate-window":
        activate_window(args.title_hint)
        return 0
    raise RuntimeError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
