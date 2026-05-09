import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const DEFAULT_BASE_URL = 'http://127.0.0.1:5173';
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 5173;
const SERVER_READY_TIMEOUT_MS = 30000;
const SERVER_POLL_INTERVAL_MS = 250;
const PLAY_PATHNAME = '/play';
const START_NAVIGATION_TIMEOUT_MS = 5000;
const START_RETRY_INTERVAL_MS = 100;
const LOCAL_SERVER_ARGS = [
	'run',
	'dev',
	'--',
	'--host',
	SERVER_HOST,
	'--port',
	String(SERVER_PORT),
	'--strictPort'
];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.APP_URL ?? DEFAULT_BASE_URL;
const shouldStartServer = process.env.APP_URL === undefined;
const homePathname = new URL(baseURL).pathname || '/';

const viewports = [
	{ name: 'mobile', width: 390, height: 844, touch: true },
	{ name: 'desktop', width: 1280, height: 720, touch: false }
];

let serverProcess = null;
let browser = null;

try {
	if (shouldStartServer) {
		serverProcess = await startLocalDevServer();
	}

	browser = await chromium.launch({ headless: true });

	for (const viewport of viewports) {
		await verifyViewport(browser, viewport);
	}
} finally {
	try {
		await browser?.close();
	} finally {
		await stopLocalDevServer(serverProcess);
	}
}

async function verifyViewport(browser, viewport) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		hasTouch: viewport.touch,
		isMobile: viewport.touch,
		deviceScaleFactor: viewport.touch ? 2 : 1
	});
	const page = await context.newPage();

	try {
		await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

		await startGame(page, viewport);

		const canvas = page.locator('canvas').first();
		await canvas.waitFor({ state: 'visible' });
		await waitForCanvasSize(page);
		await waitForBodyText(page, 'Idle');
		await waitForNonBlankCanvas(page, viewport.name);

		const center = {
			x: viewport.width / 2,
			y: viewport.height / 2
		};
		const input = viewport.touch
			? await createTouchInput(page)
			: createMouseInput(page);

		const feedbackPoint = {
			x: viewport.width / 2,
			y: viewport.height * 0.83
		};
		const idleFeedbackSignature = await canvasRegionSignature(page, feedbackPoint);
		await page.waitForTimeout(120);
		assert.equal(
			await canvasRegionSignature(page, feedbackPoint),
			idleFeedbackSignature,
			`${viewport.name} feedback sample region should stay stable before press`
		);

		// Same-point press/hold: thumb marker and tether stay skipped, only the start anchor pulse should render.
		await input.startDrag(feedbackPoint.x, feedbackPoint.y, feedbackPoint.x, feedbackPoint.y);
		await page.waitForTimeout(120);
		const pressFeedbackSignature = await canvasRegionSignature(page, feedbackPoint);
		await page.waitForTimeout(90);
		await input.endDrag();
		assert.notEqual(
			pressFeedbackSignature,
			idleFeedbackSignature,
			`${viewport.name} press feedback should alter the canvas near the start anchor before movement`
		);

		await input.tap(center.x, center.y);
		await waitForBodyText(page, 'Attack 1');

		await input.startDrag(center.x, center.y, center.x + 44, center.y);
		try {
			await waitForBodyTextMatch(page, /Walk|Run/);
			await page.waitForTimeout(520);
		} finally {
			await input.endDrag();
		}

		await page.waitForTimeout(360);
		const skillStart = {
			x: viewport.width / 2,
			y: viewport.height * 0.58
		};
		const skillTarget = {
			x: skillStart.x + 112,
			y: skillStart.y - 112
		};
		const beforeSkillBeamPixels = await countBeamLikePixels(page, center, 128);
		await input.startDrag(skillStart.x, skillStart.y, skillTarget.x, skillTarget.y);
		try {
			await waitForHudLabelMatch(page, /Walk|Run/);
			await page.waitForTimeout(420);
			assert.match(
				await getHudLabel(page),
				/Walk|Run/,
				`${viewport.name} skill beam should keep movement HUD active`
			);
			const duringSkillBeamPixels = await countBeamLikePixels(page, center, 128);
			assert.ok(
				duringSkillBeamPixels > 0 && duringSkillBeamPixels >= beforeSkillBeamPixels + 16,
				`${viewport.name} skill beam should add beam-colored pixels near the player (before=${beforeSkillBeamPixels}, during=${duringSkillBeamPixels})`
			);
		} finally {
			await input.endDrag();
		}
		await page.waitForTimeout(360);

		await input.fastDrag(center.x, center.y, center.x + 110, center.y);
		await input.fastDrag(center.x, center.y, center.x + 110, center.y);
		await waitForBodyText(page, 'Dash');

		await Promise.all([
			page.waitForURL((url) => new URL(url).pathname === homePathname),
			page.goBack()
		]);
		await page.getByRole('button', { name: '게임 시작' }).waitFor({ state: 'visible' });
		await page.getByRole('button', { name: '환경설정' }).waitFor({ state: 'visible' });
	} finally {
		await context.close();
	}
}

async function startGame(page, viewport) {
	const deadline = Date.now() + START_NAVIGATION_TIMEOUT_MS;
	let attempts = 0;
	let lastError = null;
	let optionsVerified = false;

	while (Date.now() < deadline) {
		if (isPathname(page.url(), PLAY_PATHNAME)) return;

		const remaining = Math.max(1, deadline - Date.now());
		const startButton = page.getByRole('button', { name: '게임 시작' });

		try {
			await startButton.waitFor({
				state: 'visible',
				timeout: Math.min(1000, remaining)
			});

			if (!optionsVerified) {
				await selectComfortablePreset(page, viewport, remaining);
				optionsVerified = true;
			}

			attempts += 1;

			if (viewport.touch) {
				await startButton.tap({ timeout: Math.min(1000, remaining) });
			} else {
				await startButton.click({ timeout: Math.min(1000, remaining) });
			}

			if (await waitForPlayRoute(page, Math.min(START_RETRY_INTERVAL_MS, remaining))) {
				return;
			}
		} catch (error) {
			lastError = error;
		}

		await delay(Math.min(START_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
	}

	const details = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
	throw new Error(
		`게임 시작 did not navigate to ${PLAY_PATHNAME} within ${START_NAVIGATION_TIMEOUT_MS}ms after ${attempts} attempts. Current URL: ${page.url()}.${details}`
	);
}

async function selectComfortablePreset(page, viewport, timeoutMs) {
	const settingsButton = page.getByRole('button', { name: '환경설정' });
	await settingsButton.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });

	if (viewport.touch) {
		await settingsButton.tap({ timeout: Math.min(1000, timeoutMs) });
	} else {
		await settingsButton.click({ timeout: Math.min(1000, timeoutMs) });
	}

	const dialog = page.getByRole('dialog', { name: '환경설정' });
	await dialog.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });

	const comfortableButton = dialog.getByRole('button', { name: '편안' });
	await comfortableButton.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });

	if (viewport.touch) {
		await comfortableButton.tap({ timeout: Math.min(1000, timeoutMs) });
	} else {
		await comfortableButton.click({ timeout: Math.min(1000, timeoutMs) });
	}

	const tapControl = dialog.locator('.option-slider').filter({ hasText: '탭 인식 시간' });
	await tapControl.waitFor({ state: 'visible', timeout: Math.min(1000, timeoutMs) });
	await tapControl.getByText('240 ms').waitFor({
		state: 'visible',
		timeout: Math.min(1000, timeoutMs)
	});
	await assert.equal(
		await tapControl.locator('input[type="range"]').inputValue(),
		'240',
		`${viewport.name} comfortable preset should set tap recognition slider to 240 ms`
	);

	const closeButton = dialog.getByRole('button', { name: '닫기' });
	if (viewport.touch) {
		await closeButton.tap({ timeout: Math.min(1000, timeoutMs) });
	} else {
		await closeButton.click({ timeout: Math.min(1000, timeoutMs) });
	}
	await dialog.waitFor({ state: 'hidden', timeout: Math.min(1000, timeoutMs) });
}

async function waitForPlayRoute(page, timeoutMs) {
	try {
		await page.waitForURL((url) => new URL(url).pathname === PLAY_PATHNAME, {
			timeout: timeoutMs
		});
		return true;
	} catch {
		return isPathname(page.url(), PLAY_PATHNAME);
	}
}

function isPathname(url, pathname) {
	return new URL(url).pathname === pathname;
}

function createMouseInput(page) {
	return {
		async tap(x, y) {
			await page.mouse.click(x, y);
		},
		async startDrag(startX, startY, endX, endY) {
			await page.mouse.move(startX, startY);
			await page.mouse.down();
			await page.mouse.move(endX, endY, { steps: 12 });
		},
		async endDrag() {
			await page.mouse.up();
		},
		async fastDrag(startX, startY, endX, endY) {
			await page.mouse.move(startX, startY);
			await page.mouse.down();
			await page.mouse.move(endX, endY, { steps: 2 });
			await page.mouse.up();
		}
	};
}

async function createTouchInput(page) {
	const client = await page.context().newCDPSession(page);

	return {
		async tap(x, y) {
			await dispatchTouchStart(client, x, y);
			await page.waitForTimeout(40);
			await dispatchTouchEnd(client);
		},
		async startDrag(startX, startY, endX, endY) {
			await dispatchTouchStart(client, startX, startY);
			await page.waitForTimeout(16);
			await dispatchTouchMove(client, endX, endY);
		},
		async endDrag() {
			await dispatchTouchEnd(client);
		},
		async fastDrag(startX, startY, endX, endY) {
			await dispatchTouchStart(client, startX, startY);
			await dispatchTouchMove(client, endX, endY);
			await dispatchTouchEnd(client);
		}
	};
}

async function dispatchTouchStart(client, x, y) {
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchStart',
		touchPoints: [touchPoint(x, y)]
	});
}

async function dispatchTouchMove(client, x, y) {
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchMove',
		touchPoints: [touchPoint(x, y)]
	});
}

async function dispatchTouchEnd(client) {
	await client.send('Input.dispatchTouchEvent', {
		type: 'touchEnd',
		touchPoints: []
	});
}

function touchPoint(x, y) {
	return {
		x: Math.round(x),
		y: Math.round(y),
		id: 1,
		radiusX: 8,
		radiusY: 8,
		force: 1
	};
}

async function waitForCanvasSize(page) {
	await page.waitForFunction(() => {
		const canvas = document.querySelector('canvas');
		if (!(canvas instanceof HTMLCanvasElement)) return false;

		const bounds = canvas.getBoundingClientRect();
		return canvas.width > 0 && canvas.height > 0 && bounds.width > 0 && bounds.height > 0;
	});
}

async function waitForNonBlankCanvas(page, viewportName) {
	const deadline = Date.now() + 10000;

	while (Date.now() < deadline) {
		if (await hasNonBlankCanvas(page)) return;
		await page.waitForTimeout(100);
	}

	assert.fail(`${viewportName} canvas should be nonblank`);
}

async function hasNonBlankCanvas(page) {
	return page.locator('canvas').first().evaluate((canvas) => {
		if (!(canvas instanceof HTMLCanvasElement)) return false;

		const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
		if (!gl) return false;

		const width = gl.drawingBufferWidth;
		const height = gl.drawingBufferHeight;
		if (width <= 0 || height <= 0) return false;

		const samples = [
			[Math.floor(width * 0.25), Math.floor(height * 0.25)],
			[Math.floor(width * 0.5), Math.floor(height * 0.5)],
			[Math.floor(width * 0.75), Math.floor(height * 0.75)]
		];

		for (const [x, y] of samples) {
			const pixel = new Uint8Array(4);
			gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);

			if (pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 0) {
				return true;
			}
		}

		return false;
	});
}

async function canvasRegionSignature(page, point, radius = 96) {
	return page.locator('canvas').first().evaluate((canvas, { point, radius }) => {
		if (!(canvas instanceof HTMLCanvasElement)) return '';

		const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
		if (!gl) return '';

		const width = gl.drawingBufferWidth;
		const height = gl.drawingBufferHeight;
		if (width <= 0 || height <= 0) return '';

		const bounds = canvas.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return '';

		const scaleX = width / bounds.width;
		const scaleY = height / bounds.height;
		const centerX = Math.round((point.x - bounds.left) * scaleX);
		const centerY = Math.round(height - (point.y - bounds.top) * scaleY);
		const bufferRadius = Math.round(radius * Math.max(scaleX, scaleY));
		const minX = Math.max(0, centerX - bufferRadius);
		const maxX = Math.min(width - 1, centerX + bufferRadius);
		const minY = Math.max(0, centerY - bufferRadius);
		const maxY = Math.min(height - 1, centerY + bufferRadius);
		const stride = 8;
		const pixel = new Uint8Array(4);
		let hash = 2166136261;

		for (let y = minY; y <= maxY; y += stride) {
			for (let x = minX; x <= maxX; x += stride) {
				gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
				hash ^= pixel[0];
				hash = Math.imul(hash, 16777619);
				hash ^= pixel[1];
				hash = Math.imul(hash, 16777619);
				hash ^= pixel[2];
				hash = Math.imul(hash, 16777619);
			}
		}

		return `${centerX},${centerY},${bufferRadius}:${hash >>> 0}`;
	}, { point, radius });
}

async function countBeamLikePixels(page, point, radius = 96) {
	return page.locator('canvas').first().evaluate((canvas, { point, radius }) => {
		if (!(canvas instanceof HTMLCanvasElement)) return 0;

		const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
		if (!gl) return 0;

		const width = gl.drawingBufferWidth;
		const height = gl.drawingBufferHeight;
		if (width <= 0 || height <= 0) return 0;

		const bounds = canvas.getBoundingClientRect();
		if (bounds.width <= 0 || bounds.height <= 0) return 0;

		const scaleX = width / bounds.width;
		const scaleY = height / bounds.height;
		const centerX = Math.round((point.x - bounds.left) * scaleX);
		const centerY = Math.round(height - (point.y - bounds.top) * scaleY);
		const bufferRadius = Math.round(radius * Math.max(scaleX, scaleY));
		const minX = Math.max(0, centerX - bufferRadius);
		const maxX = Math.min(width - 1, centerX + bufferRadius);
		const minY = Math.max(0, centerY - bufferRadius);
		const maxY = Math.min(height - 1, centerY + bufferRadius);
		const stride = Math.max(1, Math.round(Math.max(scaleX, scaleY)));
		const pixel = new Uint8Array(4);
		let count = 0;

		for (let y = minY; y <= maxY; y += stride) {
			for (let x = minX; x <= maxX; x += stride) {
				gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
				if (
					pixel[2] >= 235 &&
					pixel[1] >= 220 &&
					pixel[0] <= 245 &&
					pixel[2] - pixel[0] >= 10
				) {
					count += 1;
				}
			}
		}

		return count;
	}, { point, radius });
}

async function waitForBodyText(page, text) {
	await page.waitForFunction(
		(expectedText) => document.body.textContent?.includes(expectedText) === true,
		text
	);
}

async function waitForBodyTextMatch(page, pattern) {
	await page.waitForFunction(
		(patternSource) => new RegExp(patternSource).test(document.body.textContent ?? ''),
		pattern.source
	);
}

async function waitForHudLabelMatch(page, pattern) {
	await page.locator('.hud strong').waitFor({ state: 'visible' });
	await page.waitForFunction(
		(patternSource) => {
			const label = document.querySelector('.hud strong')?.textContent ?? '';
			return new RegExp(patternSource).test(label);
		},
		pattern.source
	);
}

async function getHudLabel(page) {
	return (await page.locator('.hud strong').textContent()) ?? '';
}

async function startLocalDevServer() {
	await assertPortFree(SERVER_HOST, SERVER_PORT);

	const output = [];
	const command = process.platform === 'win32' ? 'bun.exe' : 'bun';
	const child = spawn(command, LOCAL_SERVER_ARGS, {
		cwd: repoRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
		windowsHide: true
	});
	let exitDetails = null;
	let spawnError = null;

	child.stdout.on('data', (chunk) => appendServerOutput(output, chunk));
	child.stderr.on('data', (chunk) => appendServerOutput(output, chunk));
	child.once('exit', (code, signal) => {
		exitDetails = { code, signal };
	});
	child.once('error', (error) => {
		spawnError = error;
	});

	try {
		await waitForServerReady({
			getExitDetails: () => exitDetails,
			getOutput: () => output.join(''),
			getSpawnError: () => spawnError
		});

		return child;
	} catch (error) {
		await stopLocalDevServer(child);
		throw error;
	}
}

async function waitForServerReady({ getExitDetails, getOutput, getSpawnError }) {
	const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const spawnError = getSpawnError();
		if (spawnError) {
			throw new Error(`Unable to start local dev server: ${spawnError.message}`);
		}

		const exitDetails = getExitDetails();
		if (exitDetails) {
			throw new Error(formatServerExitError(exitDetails, getOutput()));
		}

		if (await appResponds()) return;
		await delay(SERVER_POLL_INTERVAL_MS);
	}

	throw new Error(
		`Local dev server did not respond at ${DEFAULT_BASE_URL} within ${SERVER_READY_TIMEOUT_MS}ms.\n${getOutput()}`
	);
}

async function appResponds() {
	try {
		const response = await fetch(DEFAULT_BASE_URL, {
			signal: AbortSignal.timeout(1000)
		});

		return response.ok;
	} catch {
		return false;
	}
}

async function assertPortFree(host, port) {
	await new Promise((resolvePromise, rejectPromise) => {
		const socket = net.createConnection({ host, port });
		let settled = false;

		function settle(callback, value) {
			if (settled) return;
			settled = true;
			socket.destroy();
			callback(value);
		}

		socket.once('connect', () => {
			settle(
				rejectPromise,
				new Error(
					`Port ${port} is already in use. Set APP_URL to verify an existing server, or stop the process using ${host}:${port}.`
				)
			);
		});

		socket.once('error', (error) => {
			if (error.code === 'ECONNREFUSED') {
				settle(resolvePromise);
				return;
			}

			settle(rejectPromise, error);
		});

		socket.setTimeout(1000, () => {
			settle(
				rejectPromise,
				new Error(`Timed out while checking whether ${host}:${port} is available.`)
			);
		});
	});
}

async function stopLocalDevServer(child) {
	if (!child || child.exitCode !== null) return;

	if (process.platform === 'win32') {
		await stopWindowsProcessTree(child.pid);
		await waitForProcessExit(child, 5000);
		return;
	}

	child.kill('SIGTERM');
	await waitForProcessExit(child, 5000);

	if (child.exitCode === null) {
		child.kill('SIGKILL');
		await waitForProcessExit(child, 5000);
	}
}

async function stopWindowsProcessTree(pid) {
	await new Promise((resolvePromise) => {
		const taskkill = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], {
			stdio: 'ignore',
			windowsHide: true
		});
		taskkill.once('close', resolvePromise);
		taskkill.once('error', resolvePromise);
	});
}

async function waitForProcessExit(child, timeoutMs) {
	if (child.exitCode !== null) return;

	await Promise.race([
		new Promise((resolvePromise) => child.once('exit', resolvePromise)),
		delay(timeoutMs)
	]);
}

function appendServerOutput(output, chunk) {
	output.push(chunk.toString());

	while (output.join('').length > 8000) {
		output.shift();
	}
}

function formatServerExitError({ code, signal }, output) {
	return `Local dev server exited before ${DEFAULT_BASE_URL} responded. Port ${SERVER_PORT} may be occupied or the app failed to start. Exit code: ${code}; signal: ${signal}.\n${output}`;
}

function delay(ms) {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}
