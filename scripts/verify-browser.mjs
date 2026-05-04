import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.APP_URL ?? 'http://127.0.0.1:5173';

const viewports = [
	{ name: 'mobile', width: 390, height: 844 },
	{ name: 'desktop', width: 1280, height: 720 }
];

const browser = await chromium.launch({ headless: true });

try {
	for (const viewport of viewports) {
		await verifyViewport(browser, viewport);
	}
} finally {
	await browser.close();
}

async function verifyViewport(browser, viewport) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height }
	});
	const page = await context.newPage();

	try {
		await page.goto(baseURL, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Game Start' }).click();

		const canvas = page.locator('canvas').first();
		await canvas.waitFor({ state: 'visible' });
		await waitForCanvasSize(page);
		await waitForNonBlankCanvas(page, viewport.name);

		const center = {
			x: viewport.width / 2,
			y: viewport.height / 2
		};

		await page.mouse.click(center.x, center.y);
		await waitForBodyText(page, 'Attack 1');

		await slowDrag(page, center.x, center.y, center.x + 44, center.y);
		await waitForBodyTextMatch(page, /Walk|Run/);
		await page.waitForTimeout(520);
		await page.mouse.up();

		await fastDrag(page, center.x, center.y, center.x + 110, center.y);
		await fastDrag(page, center.x, center.y, center.x + 110, center.y);
		await waitForBodyText(page, 'Dash');

		await page.goBack({ waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Game Start' }).waitFor({ state: 'visible' });
	} finally {
		await context.close();
	}
}

async function slowDrag(page, startX, startY, endX, endY) {
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(endX, endY, { steps: 12 });
}

async function fastDrag(page, startX, startY, endX, endY) {
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	await page.mouse.move(endX, endY, { steps: 2 });
	await page.mouse.up();
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

			if (pixel.some((channel) => channel !== 0)) {
				return true;
			}
		}

		return false;
	});
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
