ffmpeg 二进制放这里（导出视频用）

按平台建子目录，文件名固定为 ffmpeg（Windows 为 ffmpeg.exe）：

  resources/ffmpeg/mac/ffmpeg
  resources/ffmpeg/win/ffmpeg.exe
  resources/ffmpeg/linux/ffmpeg

打包时整个目录会被复制到应用资源目录下的 ffmpeg/（见 package.json 的 extraResources），
主进程按 <resources>/ffmpeg/<平台>/ffmpeg 查找（见 src/main/videoExport.ts）。

也可以：
- 装 ffmpeg-static（可选依赖，各平台预编译二进制），装了会自动找到；
- 系统 PATH 里已有 ffmpeg（如 brew install ffmpeg）；
- 临时指定：环境变量 HAO2D_FFMPEG=/绝对路径/ffmpeg。

目录为空也能正常打包/运行，只是点「导出 MP4」时会提示找不到 ffmpeg。
