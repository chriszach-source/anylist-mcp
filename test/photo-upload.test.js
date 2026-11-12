import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import AnyListClient from '../src/anylist-client.js';

// A local server stands in for the image host; client.client.post is stubbed so
// nothing reaches AnyList.
describe('AnyListClient.uploadPhotoFromUrl', () => {
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
  let server;
  let base;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/photo.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(jpeg);
      } else if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise(resolve => server.close(resolve)));

  function connectedClient() {
    const client = new AnyListClient();
    const posts = [];
    client.client = {
      client: {
        post: async (path, { body }) => {
          posts.push({ path, headers: body.getHeaders(), text: body.getBuffer().toString('latin1') });
        },
      },
    };
    return { client, posts };
  }

  it('downloads the image and posts it to data/photos/upload', async () => {
    const { client, posts } = connectedClient();
    const photoId = await client.uploadPhotoFromUrl(`${base}/photo.jpg`);

    assert.match(photoId, /^[0-9a-f]{32}$/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, 'data/photos/upload');
    assert.match(posts[0].headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(posts[0].text, new RegExp(`name="filename"\\r\\n\\r\\n${photoId}\\.jpg\\r\\n`));
    assert.match(posts[0].text, new RegExp(`name="photo"; filename="${photoId}\\.jpg"\\r\\nContent-Type: image/jpeg`));
    assert.ok(posts[0].text.includes(jpeg.toString('latin1')));
  });

  it('rejects a URL that is not an image without posting', async () => {
    const { client, posts } = connectedClient();
    await assert.rejects(client.uploadPhotoFromUrl(`${base}/page`), /not an image \(content type "text\/html"\)/);
    assert.equal(posts.length, 0);
  });

  it('rejects a failed download without posting', async () => {
    const { client, posts } = connectedClient();
    await assert.rejects(client.uploadPhotoFromUrl(`${base}/missing.jpg`), /image download failed \(HTTP 404\)/);
    assert.equal(posts.length, 0);
  });

  it('requires a connection', async () => {
    await assert.rejects(new AnyListClient().uploadPhotoFromUrl(`${base}/photo.jpg`), /Not connected/);
  });
});
