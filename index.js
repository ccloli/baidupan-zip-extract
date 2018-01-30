#!/usr/bin/env node

const fs = require('fs');
const zlib = require('zlib');
// the TextDecoder of Node.js requires to download 25MB full icu to decode GBK
const iconv = require('iconv-lite');
const stringWidth = require('string-width');

const SIGNATURE = {
	LocalFileHeader: new Uint8Array([0x50, 0x4B, 0x03, 0x04]),
	CentralDirectoryHeader: new Uint8Array([0x50, 0x4B, 0x01, 0x02]),
	EndOfCentralDirectoryRecord: new Uint8Array([0x50, 0x4B, 0x05, 0x06])
};

const LENGTH = { // with signature
	LocalFileHeader: 30, // + file name + extra field
	CentralDirectoryHeader: 46, // + file name + extra field + file comment
	EndOfCentralDirectoryRecord: 22 // + comment
};

const FOURGIGABYTES = 2 ** 32; // 1 << 32;
// const MAXUINT32 = FOURGIGABYTES - 1;
const MAXUINT16 = 0xFFFF;
// const MAXUINT8 = 0xFF;

const FATATTRIBUTE = { // low 8 bit
	// 00ADVSHR
	ARCHIVE: 1 << 5,
	DIRECTORY: 1 << 4,
	VOLUME: 1 << 3,
	SYSTEM: 1 << 2,
	HIDDEN: 1 << 1,
	READONLY: 1
};

const UNIXATTRIBUTE = { // high 4 bit
	FIFO: 1 << 28,
	CHARACTER: 1 << 29,
	DIRECTORY: 1 << 30,
	BLOCK: 1 << 30 | 1 << 29,
	FILE: 1 << 31,
	LINK: 1 << 31 | 1 << 29,
	SOCKET: 1 << 31 | 1 << 30,
};

const execShortOptions = {
	f: 'file',
	i: 'file',
	o: 'output',
	l: 'logLevel',
	e: 'encoding',
	h: 'help',
	v: 'version'
};

let options = {
	file: null,
	output: './',
	logLevel: 1,
	encoding: 'gbk' // baidupan uses GBK to package file
};


function printHelp() {
	console.log(`
  baidupan-zip-extract [options]
  bdzip-extract [options]

Options:
  -f, -i, --file, --input <path>  Specify input zip file        (required)
  -o,     --output <path>         Specify path to decompress    (default: ./)
  -e,     --encoding <charset>    Specify encoding of zip file  (default: gbk)
  -l,     --logLevel <level>      Specify log level (0-2)       (default: 1)

  -h,     --help                  Show help page
  -v,     --version               Output the version number`);
}

function printVersion() {
	console.log(process.env.npm_package_version || require('./package.json').version);
}

function log(level, log) {
	if (level <= options.logLevel) {
		console.log(log);
	}
}

function getFileSize(fd) {
	return new Promise((resolve, reject) => {
		fs.fstat(fd, (err, stats) => {
			if (err) {
				return reject(err);
			}

			log(2, '[DEBUG] getFileSize :: File stat: ' + JSON.stringify(stats));

			if (!stats.isFile()) {
				log(0, 'The inputed file is not a file, make sure the file is correct.');
				return reject(new Error('The inputed file is not a file.'));
			}

			const { size } = stats;
			resolve(size);
		});
	});
}

function readTrunk(fd, offset, len) {
	const buffer = new Buffer(len);

	return new Promise((resolve, reject) => {
		fs.read(fd, buffer, 0, len, offset, (err, bytesRead, buffer) => {
			if (err) {
				return reject(err);
			}

			resolve(buffer);
		});
	});
}

function byteSum(buffer) {
	const data = new Uint8Array(buffer);
	return data.reduceRight((pre, cur, index) => {
		// pre + cur << 8 * index
		return pre + cur * ((2 ** 8) ** index);
	}, 0);
}

function decodeFileName(buffer) {
	return iconv.decode(new Buffer(buffer), options.encoding);
}

function getProgressBar(percent, width = 20) {
	const thumb = '='.repeat(width) + ' '.repeat(width);
	const len = Math.floor(percent / (100 / width));
	return '[' + thumb.substr(width - len, width) + ']';
}

function friendlyByteSize(size) {
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
	let level = 0;

	while (size >= 1000) {
		size /= 1024;
		level++;
	}
	
	if (level > 0) {
		size = size.toFixed(2);
	}

	return size + units[level];
}

function convertFATDateTime(date, time) {
	// date: YYYYYYYM MMMDDDDD
	//       ^^^^^^^^_________ Year since 1980
	//                ^^^^____ Month
	//                    ^^^^ Day
	// time: HHHHHIII IIISSSSS
	//       ^^^^^____________ Hours
	//            ^^^ ^^^_____ Minutes
	//                   ^^^^^ Seconds / 2
	const year = (date >> 9) + 1980;
	const month = (date & 0x0480) >> 4;
	const day = date & 0x001F;
	const hours = time >> 11;
	const minutes = (time & 0x07E0) >> 5;
	const seconds = (time & 0x001F) * 2;
	return new Date(year, month, day, hours, minutes, seconds);
}

function trimToWidth(str, len) {
	let res;

	if (stringWidth(str) <= len) {
		res = str;
	}
	else {
		for (let i = Math.ceil(len / 2 - 3); i >= 0; i--) {
			let tmp = str.substr(i);
			if (stringWidth(tmp) > len - 3) {
				res = '...' + str.substr(i + 1);
				break;
			}
		}
	}

	return res;
}

function mkdir(dir) {
	const splitDir = dir.match(/(?:\.{1,2}(?:\/|\\)+)*.+?(?:\/|\\|$)+/g);
	splitDir.reduce((pre, cur) => {
		const path = pre + cur;
		try {
			fs.mkdirSync(path);
			log(1, '[INFO] mkdir :: Create folder ' + path);
		}
		catch (err) {
			if (err.code !== 'EEXIST') {
				throw err;
			}
			log(2, '[DEBUG] mkdir :: Folder ' + path + ' is exist');
		}

		return path;
	}, '');
}

function seekRealOffset(fd, offset, expected, filesize) {
	return new Promise((resolve) => {
		const seekAndCheck = () => {
			if (offset >= filesize) {
				return resolve(-1);
			}

			readTrunk(fd, offset, expected.length).then((trunk) => {
				if (expected.every((elem, index) => (elem === trunk[index]))) {
					resolve(offset);
				}
				else {
					// the offset can be addressed in 32 bit,
					// and the exceed bit will be overflow,
					// so if the offset is incorrect,
					// plus 1 << 32 to assume the overflow bits
					offset += FOURGIGABYTES;
					seekAndCheck();
				}
			});
		};

		seekAndCheck();
	});
}


function seekEndOfCentralDirectoryRecord(fd, filesize) {
	const len = LENGTH.EndOfCentralDirectoryRecord;
	const sign = SIGNATURE.EndOfCentralDirectoryRecord;

	// assume the end of central directory record doesn't have comment
	let offset = filesize - len;

	const getRecord = (buffer) => {
		const data = new Uint8Array(buffer);

		for (let i = 0, index = 0, length = data.length; i < length; i++) {
			if (data[i] === sign[index]) {
				index++;
				if (index === 4) { // find the index
					offset += i - 3;
					log(2, `[DEBUG] seekEndOfCentralDirectoryRecord :: Find end of central directory record offset: 0x${offset.toString(16).toUpperCase()}`);
					return data.slice(i - 3);
				}
			}
			else {
				index = 0;
			}
		}

		return null;
	};

	return new Promise((resolve, reject) => {
		// we don't care the comment, so get the minimal info only
		let buffer;// = new Buffer(len);

		readTrunk(fd, offset, len)
			.then((trunk) => {
				buffer = trunk;
				return getRecord(trunk);
			})
			.then((res) => {
				if (res) {
					resolve(res);
				}
				else {
					// the file has comment, seek from offset + maxLength(comment)
					// the length of comment takes 2 bytes, so its maximum is 2 << 16 - 1
					offset -= MAXUINT16;
					readTrunk(fd, offset, MAXUINT16)
						.then((trunk) => getRecord(new Buffer([trunk, buffer])))
						.then((res) => resolve(res));
				}
			}).catch((err) => reject(err));
	});
}

function decodeEndOfCentralDirectoryRecord(buffer) {
	const data = new Uint8Array(buffer);
	const res = {
		diskNum: byteSum(data.slice(4, 6)),
		startDiskNum: byteSum(data.slice(6, 8)),
		totalInDisk: byteSum(data.slice(8, 10)),
		total: byteSum(data.slice(10, 12)),
		size: byteSum(data.slice(12, 16)),
		offset: byteSum(data.slice(16, 20)),
		commentLen: byteSum(data.slice(20, 22)),
		comment: data.slice(22, byteSum(data.slice(20, 22)) + 22)
	};

	return res;
}

function correctEndOfCentralDirectoryRecord(fd, filesize, record) {
	const sign = SIGNATURE.CentralDirectoryHeader;
	return seekRealOffset(fd, record.offset, sign, filesize).then((offset) => {
		if (offset < 0) {
			log(0, 'Cannot find the first central directory header, make sure the file is not broken.');
			throw new Error('Cannot find the first central directory header');
		}

		log(2, `[DEBUG] correctEndOfCentralDirectoryRecord :: Find central directory header offset: 0x${offset.toString(16).toUpperCase()}`);

		if (record.offset !== offset) {
			log(1, `[INFO] correctEndOfCentralDirectoryRecord :: Correct central directory header offset: 0x${record.offset.toString(16).toUpperCase()} -> 0x${offset.toString(16).toUpperCase()}`);

			record.offset = offset;
		}
		return record;
	});
}

function getEndOfCentralDirectoryRecord(fd, filesize) {
	return new Promise((resolve, reject) => {
		seekEndOfCentralDirectoryRecord(fd, filesize).then((res) => {
			if (!res) {
				log(0, 'Cannot find end of central directory record, make sure the file is correct and you\'ve downloaded the whole file.');
				return reject(new Error('Cannot find end of central directory record'));
			}

			return decodeEndOfCentralDirectoryRecord(res);
		}).then((record) => {
			correctEndOfCentralDirectoryRecord(fd, filesize, record)
				.then((data) => resolve(data));
		});
	});
}

function seekCentralDirectoryHeaders(fd, offset, size, total = MAXUINT16) {
	const len = LENGTH.CentralDirectoryHeader;
	const sign = SIGNATURE.CentralDirectoryHeader;

	return readTrunk(fd, offset, size).then((trunk) => {
		const data = new Uint8Array(trunk);
		const headers = [];

		for (
			let i = 0, index = 0, count = 0, length = data.length; 
			i < length || count < total; 
			i++
		) {
			if (data[i] === sign[index]) {
				index++;
				if (index === 4) { // find the header
					i -= 3;

					const nameLen = byteSum(data.slice(i + 28, i + 30));
					const extraLen = byteSum(data.slice(i + 30, i + 32));
					const commentLen = byteSum(data.slice(i + 32, i + 34));
					const totalLen = len + nameLen + extraLen + commentLen;
					headers.push(data.slice(i, i + totalLen));

					// for-loop will plus 1 in each loop
					i += totalLen - 1;
					count++;
					index = 0;
				}
			}
		}

		return headers;
	});
}

function decodeCentralDirectoryHeader(buffer) {
	const len = LENGTH.CentralDirectoryHeader;
	const data = new Uint8Array(buffer);
	const res = {
		versionMadeBy: byteSum(data.slice(4, 6)),
		versionToExtract: byteSum(data.slice(6, 8)),
		purpose: byteSum(data.slice(8, 10)),
		compress: byteSum(data.slice(10, 12)),
		lastModTime: byteSum(data.slice(12, 14)),
		lastModDate: byteSum(data.slice(14, 16)),
		crc32: data.slice(16, 20),
		compressedSize: byteSum(data.slice(20, 24)),
		uncompressedSize: byteSum(data.slice(24, 28)),
		nameLen: byteSum(data.slice(28, 30)),
		extraLen: byteSum(data.slice(30, 32)),
		commentLen: byteSum(data.slice(32, 34)),
		diskNumStart: byteSum(data.slice(34, 36)),
		internalAttr: byteSum(data.slice(36, 38)),
		externalAttr: byteSum(data.slice(38, 42)),
		offset: byteSum(data.slice(42, 46))
	};
	const nameEnd = len + res.nameLen;
	const extraEnd = nameEnd + res.extraLen;
	const commentEnd = extraEnd + res.commentLen;
	res.name = data.slice(len, nameEnd);
	res.extra = data.slice(nameEnd, extraEnd);
	res.comment = data.slice(extraEnd, commentEnd);

	return res;
}

function correctCentralDirectoryHeaders(fd, end, headers) {
	const len = LENGTH.LocalFileHeader;
	const sign = SIGNATURE.LocalFileHeader;
	return Promise.all(headers.map((header, index) => {
		// seek the real offset of local header
		// the trunk after `end` is central directory headers,
		// it's sure the local header is not in there
		return seekRealOffset(fd, header.offset, sign, end).then((offset) => {
			if (offset < 0) {
				log(0, 'Cannot find the specific local header, make sure the file is not broken.');
				log(2, `[DEBUG] correctCentralDirectoryHeaders :: Header index: ${index } Header offset: ${header.offset }`);
				throw new Error('Cannot find the specific local header');
			}

			log(2, `[DEBUG] correctCentralDirectoryHeaders :: Find local header offset of file [${decodeFileName(header.name)}]: 0x${offset.toString(16).toUpperCase()}`);

			if (header.offset !== offset) {
				log(1, `[INFO] correctCentralDirectoryHeaders :: Correct local header offset of file [${decodeFileName(header.name)}]: 0x${header.offset.toString(16).toUpperCase()} -> 0x${offset.toString(16).toUpperCase()}`);

				header.offset = offset;
			}

			header.offset = offset;
			return header;
		});
	})).then((headers) => {
		// seek the real file size
		return headers.map((header) => {
			const { nameLen, extraLen, commentLen, offset } = header;
			let { compressedSize, uncompressedSize } = header;
			const headerLen = len + nameLen + extraLen + commentLen;
			let found = false;
			let endOffset;
			
			// note that thought we try correcting the uncompressed size,
			// it may be incorrect, because for a deflated file,
			// we cannot measure the real uncompressed size with broken value
			checkFileSizeLoop: do {
				endOffset = offset + headerLen + compressedSize;

				if (endOffset === end) {
					// it's the last file
					found = true;
					break checkFileSizeLoop;
				}

				for (let i = 0, length = headers.length; i < length; i++) {
					if (headers[i].offset === endOffset) {
						// get the next local header, update the file size
						found = true;
						break checkFileSizeLoop;
					}
				}

				// cannot find the next local header
				compressedSize += FOURGIGABYTES;
				uncompressedSize += FOURGIGABYTES;
			}
			while (offset + compressedSize <= end);

			if (found) {
				log(2, `[DEBUG] correctCentralDirectoryHeaders :: Find end offset of file [${decodeFileName(header.name)}]: 0x${offset.toString(16).toUpperCase()}`);

				if (header.compressedSize !== compressedSize) {
					log(1, `[INFO] correctCentralDirectoryHeaders :: Correct compressed size of file [${decodeFileName(header.name)}]: 0x${header.compressedSize.toString(16).toUpperCase()} (${friendlyByteSize(header.compressedSize)}) -> 0x${compressedSize.toString(16).toUpperCase()} (${friendlyByteSize(compressedSize)})`);

					header.compressedSize = compressedSize;

					// uncompressed size cannot be smaller than compressed...?
					if (uncompressedSize < compressedSize) {
						uncompressedSize += FOURGIGABYTES;
					}
					header.uncompressedSize = uncompressedSize;
				}
			}
			// should we need to case not found and throw error? or not?

			return header;
		});
	});
}

function getCentralDirectoryHeaders(fd, filesize, offset, size, total = MAXUINT16) {
	return new Promise((resolve, reject) => {
		seekCentralDirectoryHeaders(fd, offset, size, total)
			.then((trunks) => trunks.map(decodeCentralDirectoryHeader))
			.then((headers) => {
				if (!headers.length) {
					log(0, 'Cannot find any central directory header, make sure the file is not broken.');
					return reject(new Error('Cannot find any central directory header'));
				}

				correctCentralDirectoryHeaders(fd, offset, headers)
					.then((data) => resolve(data));
			});
	});
}

function seekLocalHeader(fd, offset, size) {
	const len = LENGTH.LocalFileHeader;

	const trunkSize = size || len;

	// the documentation does't say the extra field and its length
	// is whether the same as the extra field in central directory header,
	// so we needs to got that part again (thought the file name is the same,
	// and extra field is empty normally, but who knows)
	return new Promise((resolve) => {
		readTrunk(fd, offset, trunkSize).then((trunk) => {
			// the offset of local header is correct, so no need to check again
			const nameLen = byteSum(trunk.slice(26, 28));
			const extraLen = byteSum(trunk.slice(28, 30));
			let needsToRead = extraLen;

			if (!size || len + nameLen !== size) {
				needsToRead += nameLen + len - trunkSize;
			}

			// in fact, we don't care file name and extra field in local header,
			// so the following code can be removed if unnecessary
			if (needsToRead) {
				readTrunk(fd, offset + trunkSize, needsToRead)
					.then((append) => resolve(Buffer.concat([trunk, append])));
			}
			else {
				resolve(trunk);
			}
		});
		
	});
}

function decodeLocalHeader(buffer) {
	const len = LENGTH.LocalFileHeader;
	const data = new Uint8Array(buffer);
	const res = {
		versionMadeBy: byteSum(data.slice(4, 6)),
		purpose: byteSum(data.slice(6, 8)),
		compress: byteSum(data.slice(8, 10)),
		lastModTime: byteSum(data.slice(10, 12)),
		lastModDate: byteSum(data.slice(12, 14)),
		crc32: byteSum(data.slice(14, 18)),
		compressedSize: byteSum(data.slice(18, 22)),
		uncompressedSize: byteSum(data.slice(22, 26)),
		nameLen: byteSum(data.slice(26, 28)),
		extraLen: byteSum(data.slice(28, 30))
	};
	const nameEnd = len + res.nameLen;
	const extraEnd = nameEnd + res.extraLen;
	res.name = data.slice(len, nameEnd);
	res.extra = data.slice(nameEnd, extraEnd);

	return res;
}


function getLocalHeader(fd, offset, size) {
	return seekLocalHeader(fd, offset, size)
		.then((trunk) => decodeLocalHeader(trunk))
		.then((header) => {
			// the file size is incorrect, but we've got the correct size
			// in central directory header
			// by the way, the CRC 32 in local header is set
			return header;
		});
}

function sortToFileFolder(list) {
	const folders = [];
	const files = [];

	// folders are not necessary to seek local header,
	// we've got its path (and other attributes), that's enough
	// so we just need to create all the folders,
	// and the rest files are going to be seeked local header
	list.forEach((elem) => {
		const fileAttr = elem.externalAttr;
		const isUnix = elem.versionMadeBy >> 8;

		// the zip file should be MS-DOS format, but who knows
		if (isUnix) {
			// file
			if (fileAttr & UNIXATTRIBUTE.FILE) {
				files.push(elem);
			}
			// folder
			else if (fileAttr & UNIXATTRIBUTE.DIRECTORY) {
				folders.push(elem);
			}
		}
		else {
			// file
			if (fileAttr & FATATTRIBUTE.ARCHIVE) {
				files.push(elem);
			}
			// folder
			else if (fileAttr & FATATTRIBUTE.DIRECTORY) {
				folders.push(elem);
			}
		}
	});

	return { files, folders };
}

function saveFilesWithCentralDirectoryHeaders(fd, files) {
	const len = LENGTH.LocalFileHeader;

	Promise.all(files.map(({ offset, nameLen }) => {
		return getLocalHeader(fd, offset, len + nameLen);
	})).then((headers) => {
		// save all files
		const fileList = files.map((file, index) => {
			const { offset, compress, compressedSize, uncompressedSize, lastModTime, lastModDate } = file;
			const { nameLen, extraLen } = headers[index];
			const start = offset + len + nameLen + extraLen;
			const end = start + compressedSize;
			const mtime = convertFATDateTime(lastModDate, lastModTime);
			const name = decodeFileName(file.name);


			log(2, `[DEBUG] saveFilesWithCentralDirectoryHeaders :: [${decodeFileName(file.name)}] Start: 0x${start.toString(16).toUpperCase()} End: 0x${end.toString(16).toUpperCase()} mtime: ${mtime} Compress: ${compress} UncompressedSize: ${uncompressedSize}`);

			// Node.js has zlib API, so we can decompress the deflate files
			// the packaged file should be stored (not compressed), but who knows
			// if (compress & MAXUINT16) {
			// 	log(1, 'File ' + name + ' is not a stored file, the file may needs to be decompressed to open. Compression method field: ' + compress);
			// }

			return {
				name,
				start,
				end,
				mtime,
				// 8 - Deflate, 9 - Deflate64
				compress: compress === 8 || compress === 9,
				uncompressedSize
			};
		});

		saveFiles(fd, fileListGenerator(fileList));
	});
}

function* fileListGenerator(list) {
	yield* list;
}

function saveFiles(fd, fileIterator) {
	const cur = fileIterator.next();
	const { output } = options;
	const { done } = cur;

	if (done) {
		log(0, 'Save files complete!');
		return;
	}

	const { name, start, end, mtime, compress, uncompressedSize } = cur.value;
	const src = fs.createReadStream(null, {
		fd,
		start,
		end,
		autoClose: false
	});
	const dest = fs.createWriteStream(output + name);

	const atime = new Date();
	let size = uncompressedSize;
	const barWidth = (process.stdout.columns || 80) < 90 ? 15 : 20;
	const nameWidth = (process.stdout.columns || 80) - 30 - barWidth;
	let outputSize = friendlyByteSize(size);
	const outputName = trimToWidth(name, nameWidth);

	const updateProgress = () => {
		const { bytesWritten } = dest;
		// the uncompressed size we measured is incorrect
		if (bytesWritten > size) {
			size += FOURGIGABYTES;
			outputSize = friendlyByteSize(size);
		}

		const percent = (bytesWritten / size * 100).toFixed(2);
		const bar = getProgressBar(percent, barWidth);

		process.stdout.write(`${bar} ${`${percent}% `.substr(0, 6)} ${`      ${friendlyByteSize(bytesWritten)}`.substr(-8)}/${`${outputSize}      `.substr(0, 8)}  ${outputName}\r`);
	};
	const progressTimer = setInterval(updateProgress, 500);

	dest.on('close', () => {
		clearInterval(progressTimer);

		const bar = getProgressBar(100, barWidth);
		const { bytesWritten } = dest;
		// the bytesWritten is more reliable than uncompressed size we measured
		outputSize = friendlyByteSize(bytesWritten);

		log(0, `${bar} 100%   ${`      ${outputSize}`.substr(-8)}/${`${outputSize}      `.substr(0, 8)}  ${outputName}`);

		fs.utimes(output + name, atime, mtime, () => {
			// it's unnecessary whether mtime was set failed or not
		});

		if (!done) {
			return saveFiles(fd, fileIterator);
		}
		log(0, 'Save files complete!');
	});

	if (compress) {
		src.pipe(zlib.createInflateRaw()).pipe(dest);
	}
	else {
		src.pipe(dest);
	}
	updateProgress();
}

function main() {
	const { file, output } = options;

	fs.open(file, 'r', (err, fd) => {
		if (err) {
			throw err;
		}

		getFileSize(fd).then((filesize) => {
			getEndOfCentralDirectoryRecord(fd, filesize).then((record) => {
				const { offset, size, total } = record;
				getCentralDirectoryHeaders(fd, filesize, offset, size, total).then((headers) => {
					const { files, folders } = sortToFileFolder(headers);

					// create all folders
					// to make sure the file can be saved safely,
					// create all the folders that necessary
					// change mod time of a folder is meaningless,
					// as when the file decompress to the folder,
					// its mtime will be changed automatically
					if (output && output !== './') {
						mkdir(output);
					}
					folders.forEach((folder) => {
						mkdir(output + decodeFileName(folder.name));
					});

					saveFilesWithCentralDirectoryHeaders(fd, files);
				});
			});
		});
	});
}

function init() {
	const arg = process.argv.slice(2);
	let inputOptions = {};
	let curOption;

	if (!arg.length) {
		printHelp();
		process.exit();
	}
	
	arg.forEach((elem) => {
		if (elem.indexOf('--') === 0) {
			curOption = elem.substr(2);
		}
		else if (elem.indexOf('-') === 0) {
			curOption = execShortOptions[elem.substr(1)];
		}
		else if (curOption) {
			inputOptions[curOption] = elem;
		}

		if (curOption === 'help') {
			printHelp();
			process.exit();
		}
		if (curOption === 'version') {
			printVersion();
			process.exit();
		}
		if (curOption === 'input') {
			curOption = 'file';
		}
	});

	Object.keys(inputOptions).forEach((key) => {
		if (inputOptions[key]) {
			options[key] = inputOptions[key];
		}
	});

	log(2, '[DEBUG] init :: Exec: ' + arg.join(' '));

	if (!options.file) {
		log(0, 'You must specific a file to extract. Use `baidupan-zip-extract -h` to get help.');
		process.exit();
	}
	if (options.output.substr(-1) !== '/') {
		options.output += '/';
	}
	main();
}

init();