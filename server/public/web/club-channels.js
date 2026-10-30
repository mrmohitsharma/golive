import { state, get, post, put, del, el, table, day, confirmBox, toast, guard, go } from './core.js';

export const title = 'Channels';

export async function render(view) {
  const id = state.orgId;
  const [yt, chans, fb] = await Promise.all([get(`/api/orgs/${id}/youtube`), get(`/api/orgs/${id}/youtube/channels`), get(`/api/orgs/${id}/facebook`)]);
  const open = (url) => { window.open(url, '_blank', 'noopener'); toast('Finish signing in in the new tab, then come back and refresh.'); };
  const reload = () => go('/web/channels');
  view.append(
    el('h2', { text: 'YouTube' }),
    el('div', { class: 'card' },
      !yt.enabled ? el('p', { class: 'muted', text: 'YouTube sign-in is not set up on this server. You can still stream with a stream key from YouTube Studio (event > Streaming).' })
      : yt.connected ? el('div', {}, el('p', {}, 'Main channel: ', el('strong', { text: yt.channelTitle }), el('span', { class: 'muted', text: ` · connected ${day(yt.connectedAt)}` })),
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: guard(async () => open((await post(`/api/orgs/${id}/youtube/connect`)).url)), text: 'Reconnect' }),
            el('button', { class: 'btn danger', onclick: guard(async () => { if (!(await confirmBox('Disconnect YouTube?', 'Events will need a stream key or the Go Live channel.', 'Disconnect'))) return; await del(`/api/orgs/${id}/youtube`); reload(); }), text: 'Disconnect' })))
      : el('div', {}, el('p', { class: 'muted', text: 'Connect your YouTube channel: Go Live then creates each broadcast for you.' }), el('button', { class: 'btn primary', onclick: guard(async () => open((await post(`/api/orgs/${id}/youtube/connect`)).url)), text: 'Connect YouTube' }))),
    yt.enabled ? el('div', {}, el('h2', { text: 'Extra YouTube channels' }),
      table(['Channel', 'Connected', ''], (chans.channels ?? []).filter((c) => !c.main).map((c) => [c.title ?? c.channelTitle, day(c.connectedAt),
        el('button', { class: 'btn small danger', onclick: guard(async () => { await del(`/api/orgs/${id}/youtube/channels/${c.id}`); reload(); }), text: 'Remove' })]), { empty: 'None. Add more channels to stream to several at once.' }),
      el('div', { class: 'row', style: 'margin-top:8px' }, el('button', { class: 'btn small', onclick: guard(async () => open((await post(`/api/orgs/${id}/youtube/channels/connect`)).url)), text: 'Add a YouTube channel' }))) : null,
    el('h2', { text: 'Facebook Page' }),
    el('div', { class: 'card' },
      !fb.enabled ? el('p', { class: 'muted', text: 'Facebook is not set up on this server.' })
      : !fb.connected ? el('div', {}, el('p', { class: 'muted', text: 'Connect the Facebook account that manages your club\'s Page.' }), el('button', { class: 'btn primary', onclick: guard(async () => open((await post(`/api/orgs/${id}/facebook/connect`)).url)), text: 'Connect Facebook' }))
      : el('div', {}, el('p', {}, 'Signed in as ', el('strong', { text: fb.userName ?? '' })),
          el('label', { text: 'Stream to this Page' }),
          el('select', { onchange: guard(async (e) => { await put(`/api/orgs/${id}/facebook/page`, { pageId: e.target.value }); toast('Page selected'); }) },
            el('option', { value: '', text: 'Choose a Page', disabled: true, selected: !fb.pageId || undefined }), fb.pages.map((p) => el('option', { value: p.id, selected: p.id === fb.pageId || undefined, text: p.name }))),
          el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn danger', onclick: guard(async () => { await del(`/api/orgs/${id}/facebook`); reload(); }), text: 'Disconnect' })))),
    el('h2', { text: 'Instagram' }),
    el('p', { class: 'muted', text: 'Instagram gives a new stream key for each live. Paste it in the event under Streaming just before you go live.' }));
}
