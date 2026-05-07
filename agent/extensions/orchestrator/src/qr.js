const MIN_VERSION = 1;
const MAX_VERSION = 10;
const ERROR_CORRECTION_LEVEL_BITS = 0; // QR level M.

const TOTAL_CODEWORDS = [null, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ERROR_CORRECTION_CODEWORDS_PER_BLOCK = [null, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_ERROR_CORRECTION_BLOCKS = [null, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGNMENT_PATTERN_POSITIONS = [
	[],
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
];

export function renderQrSvg(value, options = {}) {
	const text = String(value ?? "");
	if (!text) throw new Error("QR code input must not be empty.");

	const bytes = [...Buffer.from(text, "utf8")];
	const version = chooseVersion(bytes.length);
	if (!version) {
		throw new Error(`QR code input is too large (${bytes.length} bytes; maximum ${maxInputBytes()} bytes).`);
	}

	const modules = encodeBytes(bytes, version);
	return modulesToSvg(modules, options);
}

function chooseVersion(byteLength) {
	for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
		const bitLength = 4 + characterCountBitLength(version) + byteLength * 8;
		if (bitLength <= dataCodewords(version) * 8) return version;
	}
	return null;
}

function maxInputBytes() {
	const version = MAX_VERSION;
	return Math.floor((dataCodewords(version) * 8 - 4 - characterCountBitLength(version)) / 8);
}

function characterCountBitLength(version) {
	return version < 10 ? 8 : 16;
}

function dataCodewords(version) {
	return TOTAL_CODEWORDS[version] - ERROR_CORRECTION_CODEWORDS_PER_BLOCK[version] * NUM_ERROR_CORRECTION_BLOCKS[version];
}

function encodeBytes(bytes, version) {
	const data = buildDataCodewords(bytes, version);
	const codewords = addErrorCorrectionAndInterleave(data, version);
	const qr = createEmptyQr(version);
	drawFunctionPatterns(qr);
	drawCodewords(qr, codewords);
	const mask = chooseMask(qr);
	applyMask(qr, mask);
	drawFormatBits(qr, mask);
	return qr.modules;
}

function buildDataCodewords(bytes, version) {
	const bits = [];
	appendBits(bits, 0b0100, 4); // Byte mode.
	appendBits(bits, bytes.length, characterCountBitLength(version));
	for (const byte of bytes) appendBits(bits, byte, 8);

	const capacityBits = dataCodewords(version) * 8;
	appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);

	const result = [];
	for (let index = 0; index < bits.length; index += 8) {
		let byte = 0;
		for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | bits[index + bit];
		result.push(byte);
	}
	for (let pad = 0xec; result.length < dataCodewords(version); pad ^= 0xec ^ 0x11) result.push(pad);
	return result;
}

function appendBits(bits, value, length) {
	for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
}

function addErrorCorrectionAndInterleave(data, version) {
	const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version];
	const blockEccLength = ERROR_CORRECTION_CODEWORDS_PER_BLOCK[version];
	const rawCodewords = TOTAL_CODEWORDS[version];
	const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
	const shortBlockLength = Math.floor(rawCodewords / numBlocks);
	const rsDivisor = reedSolomonComputeDivisor(blockEccLength);
	const blocks = [];
	let dataOffset = 0;

	for (let block = 0; block < numBlocks; block += 1) {
		const dataLength = shortBlockLength - blockEccLength + (block < numShortBlocks ? 0 : 1);
		const dataBlock = data.slice(dataOffset, dataOffset + dataLength);
		dataOffset += dataLength;
		const eccBlock = reedSolomonComputeRemainder(dataBlock, rsDivisor);
		if (block < numShortBlocks) dataBlock.push(0);
		blocks.push([...dataBlock, ...eccBlock]);
	}

	const result = [];
	for (let index = 0; index < blocks[0].length; index += 1) {
		for (let block = 0; block < blocks.length; block += 1) {
			if (index === shortBlockLength - blockEccLength && block < numShortBlocks) continue;
			result.push(blocks[block][index]);
		}
	}
	return result;
}

function reedSolomonComputeDivisor(degree) {
	const result = Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let index = 0; index < degree; index += 1) {
		for (let j = 0; j < result.length; j += 1) {
			result[j] = reedSolomonMultiply(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = reedSolomonMultiply(root, 0x02);
	}
	return result;
}

function reedSolomonComputeRemainder(data, divisor) {
	const result = Array(divisor.length).fill(0);
	for (const byte of data) {
		const factor = byte ^ result.shift();
		result.push(0);
		for (let index = 0; index < result.length; index += 1) result[index] ^= reedSolomonMultiply(divisor[index], factor);
	}
	return result;
}

function reedSolomonMultiply(left, right) {
	let x = left;
	let y = right;
	let result = 0;
	for (let index = 0; index < 8; index += 1) {
		result ^= (y & 1) * x;
		y >>>= 1;
		x = (x << 1) ^ ((x >>> 7) * 0x11d);
	}
	return result & 0xff;
}

function createEmptyQr(version) {
	const size = version * 4 + 17;
	return {
		version,
		size,
		modules: Array.from({ length: size }, () => Array(size).fill(false)),
		isFunction: Array.from({ length: size }, () => Array(size).fill(false)),
	};
}

function drawFunctionPatterns(qr) {
	const size = qr.size;
	drawFinderPattern(qr, 3, 3);
	drawFinderPattern(qr, size - 4, 3);
	drawFinderPattern(qr, 3, size - 4);

	for (let index = 0; index < size; index += 1) {
		if (!qr.isFunction[6][index]) setFunctionModule(qr, index, 6, index % 2 === 0);
		if (!qr.isFunction[index][6]) setFunctionModule(qr, 6, index, index % 2 === 0);
	}

	const positions = ALIGNMENT_PATTERN_POSITIONS[qr.version];
	for (const x of positions) {
		for (const y of positions) {
			if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue;
			drawAlignmentPattern(qr, x, y);
		}
	}

	drawFormatBits(qr, 0);
	setFunctionModule(qr, 8, size - 8, true);
	if (qr.version >= 7) drawVersionBits(qr);
}

function drawFinderPattern(qr, centerX, centerY) {
	for (let dy = -4; dy <= 4; dy += 1) {
		for (let dx = -4; dx <= 4; dx += 1) {
			const x = centerX + dx;
			const y = centerY + dy;
			if (0 <= x && x < qr.size && 0 <= y && y < qr.size) {
				const distance = Math.max(Math.abs(dx), Math.abs(dy));
				setFunctionModule(qr, x, y, distance !== 2 && distance !== 4);
			}
		}
	}
}

function drawAlignmentPattern(qr, centerX, centerY) {
	for (let dy = -2; dy <= 2; dy += 1) {
		for (let dx = -2; dx <= 2; dx += 1) {
			setFunctionModule(qr, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}
}

function setFunctionModule(qr, x, y, isDark) {
	qr.modules[y][x] = isDark;
	qr.isFunction[y][x] = true;
}

function drawCodewords(qr, codewords) {
	let bitIndex = 0;
	for (let right = qr.size - 1; right >= 1; right -= 2) {
		if (right === 6) right -= 1;
		for (let vertical = 0; vertical < qr.size; vertical += 1) {
			for (let column = 0; column < 2; column += 1) {
				const x = right - column;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? qr.size - 1 - vertical : vertical;
				if (qr.isFunction[y][x]) continue;
				let isDark = false;
				if (bitIndex < codewords.length * 8) {
					isDark = (((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0);
				}
				qr.modules[y][x] = isDark;
				bitIndex += 1;
			}
		}
	}
}

function chooseMask(qr) {
	let bestMask = 0;
	let bestPenalty = Infinity;
	for (let mask = 0; mask < 8; mask += 1) {
		const modules = qr.modules.map((row) => [...row]);
		applyMask({ ...qr, modules }, mask);
		const penalty = penaltyScore(modules);
		if (penalty < bestPenalty) {
			bestMask = mask;
			bestPenalty = penalty;
		}
	}
	return bestMask;
}

function applyMask(qr, mask) {
	for (let y = 0; y < qr.size; y += 1) {
		for (let x = 0; x < qr.size; x += 1) {
			if (!qr.isFunction[y][x] && maskBit(mask, x, y)) qr.modules[y][x] = !qr.modules[y][x];
		}
	}
}

function maskBit(mask, x, y) {
	switch (mask) {
		case 0: return (x + y) % 2 === 0;
		case 1: return y % 2 === 0;
		case 2: return x % 3 === 0;
		case 3: return (x + y) % 3 === 0;
		case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
		case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		default: throw new Error(`Invalid QR mask: ${mask}`);
	}
}

function drawFormatBits(qr, mask) {
	let data = (ERROR_CORRECTION_LEVEL_BITS << 3) | mask;
	let bits = data << 10;
	for (let index = 14; index >= 10; index -= 1) {
		if (((bits >>> index) & 1) !== 0) bits ^= 0x537 << (index - 10);
	}
	bits = ((data << 10) | bits) ^ 0x5412;

	for (let index = 0; index <= 5; index += 1) setFunctionModule(qr, 8, index, getBit(bits, index));
	setFunctionModule(qr, 8, 7, getBit(bits, 6));
	setFunctionModule(qr, 8, 8, getBit(bits, 7));
	setFunctionModule(qr, 7, 8, getBit(bits, 8));
	for (let index = 9; index < 15; index += 1) setFunctionModule(qr, 14 - index, 8, getBit(bits, index));
	for (let index = 0; index < 8; index += 1) setFunctionModule(qr, qr.size - 1 - index, 8, getBit(bits, index));
	for (let index = 8; index < 15; index += 1) setFunctionModule(qr, 8, qr.size - 15 + index, getBit(bits, index));
	setFunctionModule(qr, 8, qr.size - 8, true);
}

function drawVersionBits(qr) {
	let bits = qr.version;
	for (let index = 0; index < 12; index += 1) bits = (bits << 1) ^ ((bits >>> 11) * 0x1f25);
	bits = (qr.version << 12) | bits;
	for (let index = 0; index < 18; index += 1) {
		const isDark = getBit(bits, index);
		const a = qr.size - 11 + (index % 3);
		const b = Math.floor(index / 3);
		setFunctionModule(qr, a, b, isDark);
		setFunctionModule(qr, b, a, isDark);
	}
}

function getBit(value, index) {
	return ((value >>> index) & 1) !== 0;
}

function penaltyScore(modules) {
	return penaltyRuns(modules) + penaltyBlocks(modules) + penaltyFinderLike(modules) + penaltyBalance(modules);
}

function penaltyRuns(modules) {
	let penalty = 0;
	for (const row of modules) penalty += lineRunPenalty(row);
	for (let x = 0; x < modules.length; x += 1) penalty += lineRunPenalty(modules.map((row) => row[x]));
	return penalty;
}

function lineRunPenalty(line) {
	let penalty = 0;
	let runColor = line[0];
	let runLength = 1;
	for (let index = 1; index < line.length; index += 1) {
		if (line[index] === runColor) runLength += 1;
		else {
			if (runLength >= 5) penalty += runLength - 2;
			runColor = line[index];
			runLength = 1;
		}
	}
	if (runLength >= 5) penalty += runLength - 2;
	return penalty;
}

function penaltyBlocks(modules) {
	let penalty = 0;
	for (let y = 0; y < modules.length - 1; y += 1) {
		for (let x = 0; x < modules.length - 1; x += 1) {
			const color = modules[y][x];
			if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) penalty += 3;
		}
	}
	return penalty;
}

function penaltyFinderLike(modules) {
	let penalty = 0;
	for (const row of modules) penalty += finderLikeLinePenalty(row);
	for (let x = 0; x < modules.length; x += 1) penalty += finderLikeLinePenalty(modules.map((row) => row[x]));
	return penalty;
}

function finderLikeLinePenalty(line) {
	let penalty = 0;
	for (let index = 0; index <= line.length - 11; index += 1) {
		const window = line.slice(index, index + 11).map((bit) => (bit ? 1 : 0)).join("");
		if (window === "00001011101" || window === "10111010000") penalty += 40;
	}
	return penalty;
}

function penaltyBalance(modules) {
	let dark = 0;
	for (const row of modules) for (const module of row) if (module) dark += 1;
	const total = modules.length * modules.length;
	const k = Math.floor(Math.abs(dark * 20 - total * 10) / total);
	return k * 10;
}

function modulesToSvg(modules, options) {
	const margin = Number.isInteger(options.margin) && options.margin >= 0 ? options.margin : 1;
	const size = modules.length;
	const viewBoxSize = size + margin * 2;
	const path = [];
	for (let y = 0; y < size; y += 1) {
		let x = 0;
		while (x < size) {
			while (x < size && !modules[y][x]) x += 1;
			const start = x;
			while (x < size && modules[y][x]) x += 1;
			if (x > start) path.push(`M${start + margin},${y + margin}h${x - start}v1h-${x - start}z`);
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${path.join(" ")}"/></svg>`;
}
