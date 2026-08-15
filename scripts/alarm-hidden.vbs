' alarm-hidden.vbs — 隐藏运行 alarm-worker.cmd（计划任务经 wscript 执行，完全无窗口后台运行）
' 纯 ASCII（Windows 批处理/VBS 避免 GBK 编码坑）
Set ws = CreateObject("WScript.Shell")
ws.Run "cmd /c ""D:\projects\temp\pi-agent-install\scripts\alarm-worker.cmd""", 0, False
