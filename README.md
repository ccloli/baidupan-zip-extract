baidupan-zip-extract
====================

Extract files from "broken" Zip file downloaded from Baidu Netdisk

[_[中文文档]_](README_CN.md)

********************

## Install

Requirement: Node.js > `8.0.0`

```sh
npm install -g baidupan-zip-extract
```

## Command

```
baidupan-zip-extract [options]
bdzip-extract [options]

Options:
  -f, -i, --file, --input <path>  Specify input zip file        (required)
  -o,     --output <path>         Specify path to decompress    (default: ./)
  -e,     --encoding <charset>    Specify encoding of zip file  (default: gbk)
  -l,     --logLevel <level>      Specify log level (0-2)       (default: 1)

  -h,     --help                  Show help page
  -v,     --version               Output the version number
```

## How it works

When you download multiple files to a zip file from Baidu Netdisk, it may "broken" if the files are larger than 4 GB in total, and some files cannot be decompressed or just get part of them. In fact, it's due to the limit of ZIP file.

From [ZIP file format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT), for each file, ZIP takes 4 bytes to record compressed file size (in bytes), 4 bytes to uncompressed size, and 4 bytes to relative offset (to seek the start of each file, technically, local header). That determines a zip file cannot be larger than 4 GB, because the largest number can be stored in 4 bytes (unsigned 32 bits) is `2^32 - 1`, the overflowed bits will be ignored. Or say the size of each file in zip and zip file itself cannot be larger than 4 GB - 1 B, or some parts of files will be ignored or zip cannot seek the correct position of some files.

To fix the limit, ZIP64 comes out a few years ago, which allows you to store those number in 8 bytes, that's 16 EB - 1 B. However, Baidu Netdisk doesn't use ZIP64 to store files larger than 4 GB, but use the old ZIP format. So you may meet the problem that cannot open the "broken" zip file, or the extracted files is incomplete.

This tool helps you to seek the real position and size of each file in "broken" zip and decompress them. The principle is simple. It seeks the offset of each file, if the file is not exist at that position, the offset will be added `2^32` (4 GB) and check again until it finds the correct offset. Then it uses the same way to correct file size, then extract all the files to you.

```
                                         Central             End Of Central
                 Local    File           Directory           Directory
                 Header   Data           Header              Record
| ············ |________|______| ····· |___________| ····· |________________|
   :   :   :   ^               ^       ^         v                    v
   :   :   :...|...............|.......|___Central Directory Offset___|
   :...:.......|_______Local Header Offset_______|
       :.......................|__Header Offset__|    * Dotted: origin record
                               + Header Len + Size       Solid: corrected
```

## License

MIT

Copyright (c) 2018 ccloli (864907600cc)