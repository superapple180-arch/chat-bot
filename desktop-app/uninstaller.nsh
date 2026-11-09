!macro customUnInstall
  ${ifNot} ${isUpdated}
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否清除 chat-bot 的配置 聊天记忆和下载组件？选择否会保留数据以便重新安装" /SD IDNO IDNO keepChatBotData
    RMDir /r "$APPDATA\chat-bot"
  keepChatBotData:
  ${endIf}
!macroend
