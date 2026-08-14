using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class BookmarkBridgeHost
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Regex TokenPattern = new Regex("^[a-f0-9]{48}$", RegexOptions.Compiled);
    private static readonly HashSet<string> Commands = new HashSet<string>(StringComparer.Ordinal) {
        "bookmarks-to-chrome", "bookmarks-to-edge",
        "passwords-to-chrome", "passwords-to-edge",
        "history", "all-to-chrome", "all-to-edge"
    };

    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateBreakawayFromJob = 0x01000000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string DataDirectory
    {
        get
        {
            string overridden = Environment.GetEnvironmentVariable("BOOKMARK_BRIDGE_DATA_DIR");
            if (!String.IsNullOrEmpty(overridden)) return overridden;
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "BookmarkBridge");
        }
    }

    private static string JobsDirectory { get { return Path.Combine(DataDirectory, "jobs"); } }
    private static string RunsDirectory { get { return Path.Combine(DataDirectory, "runs"); } }
    private static string ActivePath { get { return Path.Combine(RunsDirectory, "active.json"); } }
    private static string InstallDirectory
    {
        get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }
    }

    private static Dictionary<string, object> ReadMessage()
    {
        Stream input = Console.OpenStandardInput();
        byte[] lengthBytes = ReadExact(input, 4);
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > 16 * 1024 * 1024) throw new InvalidDataException("Invalid message length.");
        string text = Encoding.UTF8.GetString(ReadExact(input, length));
        return Json.Deserialize<Dictionary<string, object>>(text);
    }

    private static byte[] ReadExact(Stream stream, int length)
    {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = stream.Read(buffer, offset, length - offset);
            if (read <= 0) throw new EndOfStreamException();
            offset += read;
        }
        return buffer;
    }

    private static void WriteRaw(string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json);
        Stream output = Console.OpenStandardOutput();
        byte[] length = BitConverter.GetBytes(body.Length);
        output.Write(length, 0, length.Length);
        output.Write(body, 0, body.Length);
        output.Flush();
    }

    private static void WriteResponse(Dictionary<string, object> response)
    {
        WriteRaw(Json.Serialize(response));
    }

    private static string RequiredString(Dictionary<string, object> message, string key)
    {
        object value;
        if (!message.TryGetValue(key, out value) || value == null) throw new InvalidDataException("Missing " + key + ".");
        return Convert.ToString(value);
    }

    private static string OptionalString(Dictionary<string, object> message, string key)
    {
        object value;
        return message.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : null;
    }

    private static string JobPath(string token) { return Path.Combine(JobsDirectory, token + ".job.json"); }
    private static string ResultPath(string token) { return Path.Combine(JobsDirectory, token + ".result.json"); }
    private static string StatePath(string token) { return Path.Combine(RunsDirectory, token + ".state.json"); }
    private static string SignalPath(string token) { return Path.Combine(RunsDirectory, token + ".signal.json"); }

    private static Dictionary<string, object> ReadJsonObject(string file)
    {
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
    }

    private static void WriteJsonFile(string file, object value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        string temporary = file + ".tmp-" + Process.GetCurrentProcess().Id + "-" + DateTime.UtcNow.Ticks;
        File.WriteAllText(temporary, Json.Serialize(value) + "\n", new UTF8Encoding(false));
        if (File.Exists(file)) File.Delete(file);
        File.Move(temporary, file);
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string FindNode()
    {
        List<string> candidates = new List<string>();
        string savedPath = Path.Combine(InstallDirectory, "node-path.txt");
        if (File.Exists(savedPath)) candidates.Add(File.ReadAllText(savedPath, Encoding.UTF8).Trim());
        string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string segment in pathValue.Split(Path.PathSeparator))
        {
            string clean = segment.Trim().Trim('"');
            if (clean.Length > 0) candidates.Add(Path.Combine(clean, "node.exe"));
        }
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (programFiles.Length > 0) candidates.Add(Path.Combine(programFiles, "nodejs", "node.exe"));
        foreach (string candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("未找到 node.exe，请重新运行 Bookmark Bridge 安装程序。");
    }

    private static int LaunchCommand(string token, string command)
    {
        string script = Path.Combine(InstallDirectory, "bookmark-bridge.js");
        if (!File.Exists(script)) throw new FileNotFoundException("安装目录缺少 bookmark-bridge.js。");
        string node = FindNode();
        StringBuilder commandLine = new StringBuilder(
            Quote(node) + " --no-warnings " + Quote(script) + " " + command + " --ui-job " + token
        );
        StartupInfo startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(typeof(StartupInfo));
        ProcessInformation process;
        uint flags = CreateNoWindow | CreateBreakawayFromJob;
        bool created = CreateProcess(node, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags,
            IntPtr.Zero, InstallDirectory, ref startup, out process);
        if (!created)
        {
            commandLine = new StringBuilder(
                Quote(node) + " --no-warnings " + Quote(script) + " " + command + " --ui-job " + token
            );
            created = CreateProcess(node, commandLine, IntPtr.Zero, IntPtr.Zero, false, CreateNoWindow,
                IntPtr.Zero, InstallDirectory, ref startup, out process);
        }
        if (!created) throw new Win32Exception(Marshal.GetLastWin32Error(), "无法启动 Bookmark Bridge 后台任务。");
        try { return process.dwProcessId; }
        finally
        {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }

    private static bool IsTerminalStatus(string status)
    {
        return status == "completed" || status == "failed" || status == "cancelled";
    }

    private static Dictionary<string, object> ActiveState()
    {
        if (!File.Exists(ActivePath)) return null;
        try
        {
            Dictionary<string, object> active = ReadJsonObject(ActivePath);
            string token = Convert.ToString(active["token"]);
            string stateFile = StatePath(token);
            if (!File.Exists(stateFile)) return null;
            Dictionary<string, object> state = ReadJsonObject(stateFile);
            string status = state.ContainsKey("status") ? Convert.ToString(state["status"]) : "starting";
            if (IsTerminalStatus(status))
            {
                if (File.Exists(ActivePath)) File.Delete(ActivePath);
                return null;
            }
            object pidValue;
            if (state.TryGetValue("pid", out pidValue))
            {
                try { Process.GetProcessById(Convert.ToInt32(pidValue)); }
                catch
                {
                    state["status"] = "failed";
                    state["phase"] = "failed";
                    state["details"] = new Dictionary<string, object> {
                        { "message", "Bookmark Bridge 后台任务已意外退出。" }
                    };
                    state["updatedAt"] = DateTime.UtcNow.ToString("o");
                    WriteJsonFile(stateFile, state);
                    if (File.Exists(ActivePath)) File.Delete(ActivePath);
                    return null;
                }
            }
            else if (status == "starting")
            {
                object createdValue;
                DateTime created;
                if (state.TryGetValue("createdAt", out createdValue) &&
                    DateTime.TryParse(Convert.ToString(createdValue), out created) &&
                    DateTime.UtcNow - created.ToUniversalTime() > TimeSpan.FromSeconds(30))
                {
                    if (File.Exists(ActivePath)) File.Delete(ActivePath);
                    return null;
                }
            }
            return state;
        }
        catch { return null; }
    }

    private static void StartRun(Dictionary<string, object> message)
    {
        string token = RequiredString(message, "token");
        string command = RequiredString(message, "command");
        if (!TokenPattern.IsMatch(token)) throw new InvalidDataException("Invalid token.");
        if (!Commands.Contains(command)) throw new InvalidDataException("不支持的 Bookmark Bridge 命令。");
        Directory.CreateDirectory(RunsDirectory);
        Dictionary<string, object> existing = ActiveState();
        if (existing != null) throw new InvalidOperationException("已有同步任务正在运行，请先查看或完成当前任务。");
        if (File.Exists(ActivePath)) File.Delete(ActivePath);

        string now = DateTime.UtcNow.ToString("o");
        Dictionary<string, object> state = new Dictionary<string, object> {
            { "token", token }, { "command", command }, { "status", "starting" },
            { "phase", "starting" }, { "output", new object[0] },
            { "createdAt", now }, { "updatedAt", now }
        };
        WriteJsonFile(StatePath(token), state);
        WriteJsonFile(ActivePath, new Dictionary<string, object> { { "token", token }, { "command", command } });
        try
        {
            int pid = LaunchCommand(token, command);
            WriteResponse(new Dictionary<string, object> { { "ok", true }, { "token", token }, { "pid", pid } });
        }
        catch
        {
            if (File.Exists(ActivePath)) File.Delete(ActivePath);
            throw;
        }
    }

    public static int Main()
    {
        try
        {
            Dictionary<string, object> message = ReadMessage();
            string action = RequiredString(message, "action");

            if (action == "run")
            {
                StartRun(message);
                return 0;
            }

            if (action == "active")
            {
                Dictionary<string, object> state = ActiveState();
                WriteResponse(new Dictionary<string, object> { { "ok", true }, { "state", state } });
                return 0;
            }

            string token = RequiredString(message, "token");
            if (!TokenPattern.IsMatch(token)) throw new InvalidDataException("Invalid token.");

            if (action == "status")
            {
                string file = StatePath(token);
                Dictionary<string, object> stateObject = File.Exists(file) ? ReadJsonObject(file) : null;
                if (stateObject != null)
                {
                    string status = stateObject.ContainsKey("status") ? Convert.ToString(stateObject["status"]) : "starting";
                    object pidValue;
                    if (!IsTerminalStatus(status) && stateObject.TryGetValue("pid", out pidValue))
                    {
                        try { Process.GetProcessById(Convert.ToInt32(pidValue)); }
                        catch
                        {
                            stateObject["status"] = "failed";
                            stateObject["phase"] = "failed";
                            stateObject["details"] = new Dictionary<string, object> {
                                { "message", "Bookmark Bridge 后台任务已意外退出。" }
                            };
                            stateObject["updatedAt"] = DateTime.UtcNow.ToString("o");
                            WriteJsonFile(file, stateObject);
                            if (File.Exists(ActivePath))
                            {
                                try
                                {
                                    Dictionary<string, object> active = ReadJsonObject(ActivePath);
                                    if (Convert.ToString(active["token"]) == token) File.Delete(ActivePath);
                                }
                                catch { }
                            }
                        }
                    }
                }
                object state = stateObject;
                WriteResponse(new Dictionary<string, object> { { "ok", true }, { "state", state } });
                return 0;
            }

            if (action == "continue" || action == "cancel")
            {
                Dictionary<string, object> signal = new Dictionary<string, object> {
                    { "action", action }, { "createdAt", DateTime.UtcNow.ToString("o") }
                };
                string value = OptionalString(message, "value");
                if (value != null) signal["value"] = value;
                WriteJsonFile(SignalPath(token), signal);
                WriteResponse(new Dictionary<string, object> { { "ok", true } });
                return 0;
            }

            Directory.CreateDirectory(JobsDirectory);
            if (action == "get")
            {
                string file = JobPath(token);
                if (!File.Exists(file)) throw new FileNotFoundException("No pending bookmark job.");
                string job = File.ReadAllText(file, Encoding.UTF8);
                WriteRaw("{\"ok\":true,\"job\":" + job + "}");
                return 0;
            }

            if (action == "complete")
            {
                object result;
                if (!message.TryGetValue("result", out result)) throw new InvalidDataException("Missing result.");
                WriteJsonFile(ResultPath(token), result);
                string job = JobPath(token);
                if (File.Exists(job)) File.Delete(job);
                WriteResponse(new Dictionary<string, object> { { "ok", true } });
                return 0;
            }

            throw new InvalidDataException("Unknown action.");
        }
        catch (Exception error)
        {
            WriteResponse(new Dictionary<string, object> {
                { "ok", false }, { "error", error.Message }
            });
            return 1;
        }
    }
}
