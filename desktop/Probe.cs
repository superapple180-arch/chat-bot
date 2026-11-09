using System;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Windows.Automation;
using System.Web.Script.Serialization;
class Probe {
 [STAThread] static void Main() {
 Console.OutputEncoding = new UTF8Encoding(false);
 var p=Process.GetProcessesByName("Gemini").Single(x=>x.MainWindowHandle!=IntPtr.Zero);
 var root=AutomationElement.FromHandle(p.MainWindowHandle);
 var all=root.FindAll(TreeScope.Descendants,Condition.TrueCondition).Cast<AutomationElement>();
 var rows=all.Where(e=>e.Current.ControlType==ControlType.Document || e.Current.ControlType==ControlType.Edit || e.Current.ControlType==ControlType.Button || (e.Current.AutomationId??"").StartsWith("model-response") || (e.Current.AutomationId??"").StartsWith("user-query"))
 .Select(e=>new {type=e.Current.ControlType.ProgrammaticName,id=e.Current.AutomationId,name=(e.Current.ControlType==ControlType.Button || e.Current.ControlType==ControlType.Edit)?e.Current.Name:"[redacted]",draft=DraftInfo(e),patterns=e.GetSupportedPatterns().Select(x=>x.ProgrammaticName).ToArray()}).ToArray();
 Console.WriteLine(new JavaScriptSerializer().Serialize(rows));
 }
 static object DraftInfo(AutomationElement e) {
 if(e.Current.ControlType!=ControlType.Edit) return null;
 object p; if(!e.TryGetCurrentPattern(ValuePattern.Pattern,out p)) return null;
 string v=((ValuePattern)p).Current.Value;
 return new { length=v.Length, safePlaceholder=System.Text.RegularExpressions.Regex.IsMatch(v,"^\\s*(问问\\s*Gemini|Ask\\s+Gemini|为 Gemini 输入提示)\\s*$")?v:"[redacted]", nameEqual=v==e.Current.Name };
 }
}
