// /web/pair?code=123456: the Go Live laptop app opens this page with its code.
export const title = 'Link a laptop';
export const render = (view) => import('./laptop.js').then((m) => m.renderPair(view));
