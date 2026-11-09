using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

// Independent UIA client. Never loads Gemini code, credentials or debugging APIs.
class GeminiDriver {
    class DriverFailure : Exception { public DriverFailure(string code) : base(code) { } }
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X; public int Y; }
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 2097152 };
    static IntPtr handle;
    static AutomationElement root;
    static string stage = "READ_FAILED";
    static bool invoked;
    static string Field(Dictionary<string, object> input, string key) { return input.ContainsKey(key) ? Convert.ToString(input[key]) : ""; }
    static void Fail(string code) { throw new DriverFailure(code); }
    static string Value(AutomationElement e) { object p; return e.TryGetCurrentPattern(ValuePattern.Pattern, out p) ? ((ValuePattern)p).Current.Value ?? "" : ""; }
    static AutomationElement[] All(AutomationElement e) { return e.FindAll(TreeScope.Descendants, Condition.TrueCondition).Cast<AutomationElement>().ToArray(); }
    static AutomationElement One(IEnumerable<AutomationElement> all, Func<AutomationElement, bool> f, string label) {
        var found = all.Where(f).ToArray();
        if (found.Length != 1) Fail("CONTROL_" + label);
        return found[0];
    }
    static string Id(AutomationElement e) { return e.Current.AutomationId ?? ""; }
    static AutomationElement[] Users(AutomationElement[] e) { return e.Where(x => Id(x).StartsWith("user-query-content-")).ToArray(); }
    static AutomationElement[] Replies(AutomationElement[] e) { return e.Where(x => Id(x).StartsWith("model-response-message-content")).ToArray(); }
    static string Compact(string s) { return Regex.Replace(s, "\\s+", ""); }
    static bool PromptMatches(AutomationElement element, string prompt) {
        // The heading contains a truncated duplicate summary; compare only body text.
        string actual = string.Concat(All(element).Where(x => x.Current.ControlType == ControlType.Text &&
            !Regex.IsMatch(x.Current.LocalizedControlType ?? "", "^(标题|heading)", RegexOptions.IgnoreCase)).Select(x => x.Current.Name));
        return Compact(actual) == Compact(prompt);
    }
    static string Text(AutomationElement e) {
        object p;
        if (e.TryGetCurrentPattern(TextPattern.Pattern, out p)) return ((TextPattern)p).DocumentRange.GetText(-1).Trim();
        var result = new StringBuilder();
        Walk(e, result);
        return result.ToString().Trim();
    }
    static void Walk(AutomationElement e, StringBuilder result) {
        var type = e.Current.ControlType;
        if (type == ControlType.Button) return;
        if (type == ControlType.Text) { result.Append(e.Current.Name); return; }
        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(e);
        if (child == null && type == ControlType.Hyperlink) result.Append(e.Current.Name);
        while (child != null) { Walk(child, result); child = walker.GetNextSibling(child); }
        if (type == ControlType.Group || type == ControlType.ListItem) result.AppendLine();
    }
    static string Url(AutomationElement[] e) {
        var urls = e.Where(x => x.Current.ControlType == ControlType.Document).Select(Value)
            .Where(x => Regex.IsMatch(x, "^https://gemini\\.google\\.com/app(?:/|$)")).Distinct().ToArray();
        if (urls.Length != 1) Fail("LOGIN_OR_DOCUMENT_UNAVAILABLE");
        var uri = new Uri(urls[0]);
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }
    static string Mode(AutomationElement[] e) {
        var modes = e.Where(x => x.Current.ControlType == ControlType.Button).Select(x => Regex.Match(x.Current.Name ?? "", "(?:当前模式为[“\"]|current mode (?:is )?[\"“]?)([^”\"]+)", RegexOptions.IgnoreCase))
            .Where(x => x.Success).Select(x => x.Groups[1].Value.Trim()).Distinct().ToArray();
        if (modes.Length != 1) Fail("MODE_UNAVAILABLE");
        // Refuse task/agent modes: incoming QQ text must never operate the computer.
        if (!Regex.IsMatch(modes[0], "^(Flash(?:-Lite)?|Fast|Thinking|Pro|快速|思考)$", RegexOptions.IgnoreCase)) Fail("UNSAFE_OR_UNKNOWN_MODE");
        return modes[0];
    }
    static bool Button(AutomationElement e, params string[] names) { return e.Current.ControlType == ControlType.Button && names.Contains(e.Current.Name); }
    static bool Busy(AutomationElement[] e) { return e.Any(x => Button(x, "停止回答", "Stop response", "Stop")); }
    static AutomationElement Composer(AutomationElement[] e) { return One(e, x => x.Current.ControlType == ControlType.Edit && new[] { "为 Gemini 输入提示", "Enter a prompt for Gemini" }.Contains(x.Current.Name), "COMPOSER"); }
    static string Draft(AutomationElement[] e) {
        var raw = Value(Composer(e));
        var s = raw.TrimEnd('\r', '\n');
        if (s == "问问 Gemini" || s == "Ask Gemini") return "";
        return s.Length == 0 ? raw : s;
    }
    static string Hash(string s) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-", ""); }
    static string Fingerprint(AutomationElement[] e) {
        var users = Users(e); var replies = Replies(e);
        return Hash(Url(e) + "\n" + Mode(e) + "\n" + users.Length + "\n" + replies.Length + "\n" +
            (users.Length == 0 ? "" : Text(users.Last())) + "\n" + (replies.Length == 0 ? "" : Text(replies.Last())));
    }
    static object Describe(AutomationElement[] e, string answer, string marker) {
        return new { url = Url(e), mode = Mode(e), busy = Busy(e), hasDraft = Draft(e).Length > 0,
            fingerprint = Fingerprint(e), userCount = Users(e).Length, responseCount = Replies(e).Length,
            minimized = IsIconic(handle), text = answer, marker = marker, submitted = invoked };
    }
    static void Idle(AutomationElement[] e) {
        if (Busy(e)) Fail("ALREADY_GENERATING");
        if (Draft(e).Length > 0) Fail("MANUAL_DRAFT");
    }
    static void Expected(AutomationElement[] e, Dictionary<string, object> input) {
        if (Mode(e) != Field(input, "mode")) Fail("MODE_CHANGED");
        if (Field(input, "fingerprint").Length == 0 || Fingerprint(e) != Field(input, "fingerprint")) Fail("USER_INTERVENED");
    }
    static void Invoke(AutomationElement e) {
        object p;
        if (!e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) Fail("INVOKE_UNAVAILABLE");
        if (!e.Current.IsEnabled) Fail("CONTROL_DISABLED");
        ((InvokePattern)p).Invoke();
    }
    static void NavigateClick(AutomationElement e) {
        // Only a UIA-resolved hyperlink in the verified Gemini window can be clicked.
        bool top = (GetWindowLong(handle, -20) & 8) != 0;
        try {
            object scroll;
            if (e.TryGetCurrentPattern(ScrollItemPattern.Pattern, out scroll)) ((ScrollItemPattern)scroll).ScrollIntoView();
            SetForegroundWindow(handle);
            if (!SetWindowPos(handle, new IntPtr(-1), 0, 0, 0, 0, 0x0013)) Fail("WINDOW_UNAVAILABLE");
            Thread.Sleep(150);
            var p = e.GetClickablePoint(); var pt = new Point { X = (int)p.X, Y = (int)p.Y };
            if (GetAncestor(WindowFromPoint(pt), 2) != handle) Fail("WINDOW_COVERED");
            if (!SetCursorPos(pt.X, pt.Y)) Fail("CLICK_UNAVAILABLE");
            mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
        } finally { if (!top) SetWindowPos(handle, new IntPtr(-2), 0, 0, 0, 0, 0x0013); }
    }
    static AutomationElement[] Ready() {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 15000) {
            try { var e = All(root); Url(e); Mode(e); Composer(e); return e; }
            catch (DriverFailure ex) { if (ex.Message == "UNSAFE_OR_UNKNOWN_MODE") throw; Thread.Sleep(250); }
            catch (ElementNotAvailableException) { Thread.Sleep(250); }
        }
        Fail("LOGIN_OR_CONTROLS_NOT_READY"); return null;
    }
    static AutomationElement[] Navigate(string target, string mode) {
        var e = All(root);
        if (Url(e) == target) return e;
        Idle(e);
        NavigateClick(One(e, x => x.Current.ControlType == ControlType.Hyperlink && Value(x).TrimEnd('/') == target, "SESSION_LINK"));
        var watch = Stopwatch.StartNew();
        string previous = ""; int stable = 0; bool arrived = false;
        while (watch.ElapsedMilliseconds < 15000) {
            Thread.Sleep(250);
            try {
                if (IsIconic(handle)) Fail("MINIMIZED_RESTORE_MANUALLY");
                e = All(root);
                if (Mode(e) != mode) Fail("MODE_CHANGED");
                if (Draft(e).Length > 0) Fail("MANUAL_DRAFT");
                if (Url(e) != target) {
                    if (arrived) Fail("SESSION_CHANGED");
                    stable = 0; continue;
                }
                arrived = true; Idle(e);
                string current = Fingerprint(e);
                stable = current == previous ? stable + 1 : 0;
                previous = current;
                if (stable >= 3) return e;
            } catch (ElementNotAvailableException) { stable = 0; }
        }
        Fail("SESSION_RESTORE_FAILED"); return null;
    }
    static object Run(Dictionary<string, object> input) {
        var directory = System.IO.Path.GetFullPath(Field(input, "directory")).TrimEnd('\\') + "\\";
        var found = Process.GetProcessesByName("Gemini").Where(p => {
            try { return p.MainWindowHandle != IntPtr.Zero && p.MainModule.FileName.StartsWith(directory, StringComparison.OrdinalIgnoreCase); } catch { return false; }
        }).ToArray();
        if (found.Length != 1) Fail("WINDOW_MISSING_OR_AMBIGUOUS");
        handle = found[0].MainWindowHandle; root = AutomationElement.FromHandle(handle);
        var e = Ready(); var action = Field(input, "action");
        if (action == "observe") return Describe(e, "", "");
        stage = "GENERATION_FAILED";
        if (IsIconic(handle)) Fail("MINIMIZED_RESTORE_MANUALLY");
        Idle(e); Expected(e, input);
        var mode = Field(input, "mode"); var url = Field(input, "url");
        if (action == "new") {
            e = Navigate("https://gemini.google.com/app", mode);
            if (Users(e).Length != 0 || Replies(e).Length != 0) Fail("NEW_SESSION_NOT_EMPTY");
            return Describe(e, "", "");
        }
        if (action == "check") return Describe(e, "", "");
        if (action != "send") Fail("INVALID_ACTION");
        if (!Regex.IsMatch(url, "^https://gemini\\.google\\.com/app(?:/[a-zA-Z0-9_-]+)?$")) Fail("INVALID_SESSION_URL");
        e = Navigate(url, mode); Idle(e);
        string prompt = Field(input, "text"), marker = Field(input, "marker");
        if (!Regex.IsMatch(marker, "^QQBRIDGE_[a-f0-9]{32}$") || !prompt.EndsWith(marker)) Fail("INVALID_MARKER");
        var beforeUsers = Users(e).Length; var beforeReplies = Replies(e).Select(Id).ToArray();
        object pattern; var composer = Composer(e);
        if (!composer.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) Fail("VALUE_PATTERN_UNAVAILABLE");
        composer.SetFocus();
        e = All(root); Idle(e);
        if (Url(e) != url || Mode(e) != mode || Users(e).Length != beforeUsers) Fail("DRAFT_OR_SESSION_CHANGED");
        composer = Composer(e);
        if (!composer.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) Fail("VALUE_PATTERN_UNAVAILABLE");
        ((ValuePattern)pattern).SetValue(prompt);
        Thread.Sleep(200); e = All(root);
        if (Url(e) != url || Mode(e) != mode || Draft(e) != prompt || Users(e).Length != beforeUsers) Fail("DRAFT_OR_SESSION_CHANGED");
        // After invocation any failure is uncertain; this driver never retries a submit.
        invoked = true;
        Invoke(One(e, x => Button(x, "发送", "Send message", "Send"), "SEND"));
        var watch = Stopwatch.StartNew(); var stable = 0; string previous = ""; bool confirmed = false;
        int timeout = input.ContainsKey("timeoutMs") ? Convert.ToInt32(input["timeoutMs"]) : 120000;
        while (watch.ElapsedMilliseconds < timeout) {
            Thread.Sleep(400);
            try {
                if (IsIconic(handle)) Fail("MINIMIZED_RESTORE_MANUALLY");
                e = All(root);
                if (Mode(e) != mode) Fail("MODE_CHANGED");
                var currentUrl = Url(e);
                if (url == "https://gemini.google.com/app" && currentUrl.StartsWith(url + "/")) url = currentUrl;
                if (currentUrl != url) Fail("SESSION_CHANGED");
                var users = Users(e); var draft = Draft(e);
                if (draft.Length > 0 && draft != prompt) Fail("MANUAL_DRAFT");
                bool owns = users.Length == beforeUsers + 1 && PromptMatches(users.Last(), prompt);
                if (!owns) {
                    if (confirmed || users.Length > beforeUsers) Fail("PROMPT_OWNERSHIP_LOST");
                    if (watch.ElapsedMilliseconds > 10000) Fail("SUBMISSION_UNCONFIRMED");
                    continue;
                }
                confirmed = true;
                var replies = Replies(e); var last = replies.LastOrDefault();
                bool fresh = last != null && !beforeReplies.Contains(Id(last)) && replies.Length == beforeReplies.Length + 1;
                stage = !Busy(e) && fresh ? "READ_FAILED" : "GENERATION_FAILED";
                string answer = fresh ? Text(last) : "";
                // Copy/rating actions are outside the text node and appear when the turn finishes.
                bool completed = e.Count(x => Button(x, "复制", "Copy")) >= replies.Length;
                stable = fresh && completed && !Busy(e) && answer.Length > 0 && draft.Length == 0 && answer == previous ? stable + 1 : 0;
                previous = answer;
                if (stable >= 4) return Describe(e, answer, marker);
            } catch (ElementNotAvailableException) { stable = 0; }
        }
        Fail(confirmed ? "GENERATION_TIMEOUT" : "SUBMISSION_UNCONFIRMED"); return null;
    }
    [STAThread] static void Main() {
        Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = new UTF8Encoding(false);
        using (var mutex = new Mutex(false, "Local\\QQGeminiDesktopDriver")) {
            bool held = false;
            try {
                try { held = mutex.WaitOne(0); } catch (AbandonedMutexException) { held = true; }
                if (!held) Fail("DRIVER_ALREADY_RUNNING");
                var input = Json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
                Console.WriteLine(Json.Serialize(Run(input)));
            } catch (Exception ex) {
                string code = ex is DriverFailure ? ex.Message : "UIA_UNAVAILABLE";
                Console.WriteLine(Json.Serialize(new { error = code, category = stage, submitted = invoked, diagnosticType = ex.GetType().Name, diagnosticStack = new StackTrace(ex, false).ToString() }));
                Environment.ExitCode = 1;
            } finally { if (held) mutex.ReleaseMutex(); }
        }
    }
}
