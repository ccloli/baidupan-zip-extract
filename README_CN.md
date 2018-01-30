baidupan-zip-extract
====================

解压从百度网盘上批量下载的“损坏”的 zip 文件

[_[ENGLISH README]_](README.md)

********************

## 安装

要求：Node.js > `8.0.0`

```sh
npm install -g baidupan-zip-extract
```

## 指令

```
baidupan-zip-extract [options]
bdzip-extract [options]

参数：
  -f, -i, --file, --input <path>  定义输入文件        (必需)
  -o,     --output <path>         定义输出目录        (默认: ./)
  -e,     --encoding <charset>    定义文件编码        (默认: gbk)
  -l,     --logLevel <level>      定义日志等级 (0-2)  (默认: 1)

  -h,     --help                  显示帮助页面
  -v,     --version               显示版本号
```

## 原理

当你从百度网盘上使用批量下载功能下载多个文件时，如果这些文件的总大小大于 4 GB，你可能会遇到文件“损坏”的情况，一些文件无法被解压或者只能获取这些文件的一部分内容。实际上，这是 ZIP 文件格式的限制所导致的。

根据 [ZIP 文件格式详细说明文档](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)，对任何储存在 zip 内的文件，ZIP 使用 4 字节记录压缩后的文件大小（以字节的形式），4 字节记录压缩前的文件大小，以及 4 字节记录文件的相对偏移量（用于寻址文件的开始位置，技术上来说是该文件的 local header 的位置）。这就决定了一个 zip 文件不能够大于 4 GB，因为 4 字节能记录的最大数字（32 位无符号数）是 `2^32 - 1`，溢出的数据位将会无法存储。或者说，对于 zip 内的每个文件甚至 zip 文件本身，它们的大小都不能超过 4 GB - 1 B，否则文件的一部分数据将会被跳过，或者 zip 无法正确找到部分文件的正确位置。

为了解决这个限制，在几年前出现了 ZIP64 格式，它能够将这些值使用 8 字节进行存储，也就是能达到 16 EB - 1 B。然而，百度网盘并没有针对 4 GB 以上的文件使用 ZIP64 格式，而是继续使用旧版本的 ZIP 格式。所以这就是你无法打开这些“损坏”的 zip 文件，或者解压的文件不完整的原因。

这个工具能够帮助你从这些“损坏”的 zip 文件中寻找到每个文件的实际位置和文件大小，并将它们解压出来。它的原理很简单，它会对每个文件的偏移量进行寻址，如果文件并不在该偏移量上，偏移量将会自增 `2^32`（4 GB）并再次检查，直到找到正确的偏移量。然后它会使用同样的方式来确定文件的大小，并提取所有的文件。

```
                                         Central             End Of Central
                 Local    File           Directory           Directory
                 Header   Data           Header              Record
| ············ |________|______| ····· |___________| ····· |________________|
   :   :   :   ^               ^       ^         v                    v
   :   :   :...|...............|.......|___Central Directory Offset___|
   :...:.......|_______Local Header Offset_______|
       :.......................|__Header Offset__|    * 虚线：原始记录
                               + Header Len + Size      实线：纠正后的记录
```

## 许可协议

MIT

Copyright (c) 2018 ccloli (864907600cc)