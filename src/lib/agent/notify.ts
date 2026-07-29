// Dependency-free desktop notifications for the CLI `watch` mode. Uses each OS's
// native mechanism via a child process, so there's no npm dependency to add:
//   • Windows → a real toast through the WinRT ToastNotificationManager
//   • macOS   → osascript "display notification"
//   • Linux   → notify-send (if installed)
// Any failure degrades silently to a console line — a missed toast must never
// crash the watcher.

import { spawn } from "child_process";

function run(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    child.on("error", () => {}); // ignore "command not found" etc.
  } catch {
    /* ignore */
  }
}

const psEscape = (s: string) => s.replace(/'/g, "''");

export function notifyDesktop(title: string, message: string): void {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      const script = [
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
        "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
        "$x = $t.GetElementsByTagName('text')",
        `$x[0].AppendChild($t.CreateTextNode('${psEscape(title)}')) | Out-Null`,
        `$x[1].AppendChild($t.CreateTextNode('${psEscape(message)}')) | Out-Null`,
        "$toast = [Windows.UI.Notifications.ToastNotification]::new($t)",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('AI Job Agent').Show($toast)",
      ].join("; ");
      run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    } else if (platform === "darwin") {
      run("osascript", ["-e", `display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"`]);
    } else {
      run("notify-send", [title, message]);
    }
  } catch {
    /* ignore */
  }
  // Always also echo to the console so headless/over-SSH usage still sees it.
  console.log(`🔔 ${title} — ${message}`);
}
