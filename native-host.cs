using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class BookmarkBridgeHost
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly Regex TokenPattern = new Regex("^[a-f0-9]{48}$", RegexOptions.Compiled);

    private static string JobsDirectory
    {
        get
        {
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(local, "BookmarkBridge", "jobs");
        }
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

    private static string RequiredString(Dictionary<string, object> message, string key)
    {
        object value;
        if (!message.TryGetValue(key, out value) || value == null) throw new InvalidDataException("Missing " + key + ".");
        return Convert.ToString(value);
    }

    private static string JobPath(string token) { return Path.Combine(JobsDirectory, token + ".job.json"); }
    private static string ResultPath(string token) { return Path.Combine(JobsDirectory, token + ".result.json"); }

    public static int Main()
    {
        try
        {
            Dictionary<string, object> message = ReadMessage();
            string action = RequiredString(message, "action");
            string token = RequiredString(message, "token");
            if (!TokenPattern.IsMatch(token)) throw new InvalidDataException("Invalid token.");
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
                string destination = ResultPath(token);
                string temporary = destination + ".tmp-" + System.Diagnostics.Process.GetCurrentProcess().Id;
                File.WriteAllText(temporary, Json.Serialize(result), new UTF8Encoding(false));
                if (File.Exists(destination)) File.Delete(destination);
                File.Move(temporary, destination);
                string job = JobPath(token);
                if (File.Exists(job)) File.Delete(job);
                WriteRaw("{\"ok\":true}");
                return 0;
            }

            throw new InvalidDataException("Unknown action.");
        }
        catch (Exception error)
        {
            WriteRaw(Json.Serialize(new Dictionary<string, object> {
                { "ok", false },
                { "error", error.Message }
            }));
            return 1;
        }
    }
}
