import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingLinks, meetingLinkForThread, unwrapLink } from '../src/meeting-links.js';

test('finds each provider', () => {
  const text = `Google Meet: https://meet.google.com/abc-defg-hij
Zoom: https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123
Teams: https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZTk1%40thread.v2/0?context=%7b%22Tid%22%7d
Webex: https://example.webex.com/meet/host
Webex2: https://acme.webex.com/acme/j.php?MTID=m1234abcd`;
  assert.deepEqual(meetingLinks(text).map((l) => l.kind), ['meet', 'zoom', 'teams', 'webex', 'webex']);
  assert.equal(meetingLinks(text)[1].url, 'https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123');
});

test('Japanese punctuation and brackets end the link', () => {
  const l = meetingLinks('こちらのURLからご参加ください（https://meet.google.com/abc-defg-hij）。');
  assert.deepEqual(l, [{ url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' }]);
  assert.equal(meetingLinks('URL：https://zoom.us/j/123456789。よろしくお願いします')[0].url, 'https://zoom.us/j/123456789');
});

test('unwraps Gmail, Outlook Safe Links and Proofpoint wrappers', () => {
  const g = 'https://www.google.com/url?q=https://meet.google.com/abc-defg-hij&sa=D&source=calendar&usg=AOvVaw0';
  const s = `https://apc01.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://zoom.us/j/987654321?pwd=x')}&data=05%7C01&reserved=0`;
  const p = 'https://urldefense.com/v3/__https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0__;!!abc$';
  assert.equal(unwrapLink(g), 'https://meet.google.com/abc-defg-hij');
  assert.deepEqual(meetingLinks(`${g}\n${s}\n${p}`).map((l) => [l.kind, l.url]), [
    ['meet', 'https://meet.google.com/abc-defg-hij'],
    ['zoom', 'https://zoom.us/j/987654321?pwd=x'],
    ['teams', 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0'],
  ]);
  // A double wrap (Safe Links around a Gmail redirect).
  assert.equal(meetingLinks(`https://nam.safelinks.protection.outlook.com/?url=${encodeURIComponent(g)}`)[0].url, 'https://meet.google.com/abc-defg-hij');
});

test('preview, site and provider marketing links are not meetings', () => {
  const text = `プレビュー: https://example.com/acme-site-preview/
弊社サイト https://www.example.co.jp/
https://zoom.us/download https://zoom.us/pricing https://www.microsoft.com/ja-jp/microsoft-teams/
https://teams.microsoft.com/downloads https://meet.google.com/ https://www.webex.com/ja/index.html
https://calendly.com/leo/30min https://www.google.com/maps/place/x`;
  assert.deepEqual(meetingLinks(text), []);
  assert.deepEqual(meetingLinks(''), []);
  assert.deepEqual(meetingLinks(undefined), []);
});

test('dedupes and the thread uses the latest link', () => {
  assert.equal(meetingLinks('https://meet.google.com/abc-defg-hij https://meet.google.com/abc-defg-hij.').length, 1);
  const link = meetingLinkForThread([
    { body: 'https://zoom.us/j/111111111' },
    { body: 'お世話になっております。日程承知しました。' },
    { full: 'URLが変わりました https://meet.google.com/xyz-abcd-efg' },
  ]);
  assert.deepEqual(link, { url: 'https://meet.google.com/xyz-abcd-efg', kind: 'meet' });
  assert.equal(meetingLinkForThread([{ body: 'no link' }]), null);
});
