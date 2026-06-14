import { AwsClient } from "aws4fetch";

// Backblaze B2 (S3-compatible) ကို proxy လုပ်တဲ့ Cloudflare Worker
// User URL:  https://cdn.mydomain.com/movie/video.mp4
// ဒီ path ကို B2 bucket ထဲက object key အဖြစ် တိုက်ရိုက် map လုပ်ပါတယ်။

export default {
  async fetch(request, env, ctx) {
    // GET နဲ့ HEAD ကိုပဲ ခွင့်ပြုပါတယ် (video streaming အတွက် လုံလောက်ပါတယ်)
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const url = new URL(request.url);

    // path ထဲက အရင်ဆုံး "/" ကို ဖယ်ပြီး object key အဖြစ်ယူပါတယ်။
    // ဥပမာ: /movie/video.mp4  ->  movie/video.mp4
    let objectKey = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

    if (!objectKey) {
      return new Response("Not Found", { status: 404 });
    }

    // ---- Cache key တည်ဆောက်ခြင်း ----
    // Range request တွေကို သီးခြား cache လုပ်နိုင်ဖို့ Range header ကိုပါ
    // cache key ထဲ ထည့်ပေးပါတယ်။ (Worker Cache API က default အနေနဲ့
    // Range ကို မစစ်ဆေးတဲ့အတွက် ကိုယ်တိုင် ထည့်ပေးရပါတယ်)
    const cache = caches.default;
    const rangeHeader = request.headers.get("Range") || "";

    const cacheUrl = new URL(request.url);
    if (rangeHeader) {
      cacheUrl.searchParams.set("range", rangeHeader);
    }
    const cacheKey = new Request(cacheUrl.toString(), {
      method: "GET",
      headers: rangeHeader ? { Range: rangeHeader } : {},
    });

    // ---- Cache ထဲ ရှိ/မရှိ စစ်ဆေးခြင်း ----
    let response = await cache.match(cacheKey);
    if (response) {
      // Cache HIT
      const cached = new Response(response.body, response);
      cached.headers.set("X-Cache", "HIT");
      return cached;
    }

    // ---- Backblaze B2 (S3 API) သို့ signed request ပြုလုပ်ခြင်း ----
    const aws = new AwsClient({
      accessKeyId: env.B2_ACCESS_KEY_ID,
      secretAccessKey: env.B2_SECRET_ACCESS_KEY,
      service: "s3",
      region: env.B2_REGION, // ဥပမာ: us-west-004
    });

    // B2 S3 endpoint:  https://s3.<region>.backblazeb2.com/<bucket>/<key>
    const b2Endpoint = `https://s3.${env.B2_REGION}.backblazeb2.com`;
    const originUrl = `${b2Endpoint}/${env.B2_BUCKET_NAME}/${objectKey}`;

    // Origin သို့ ပို့မယ့် headers (Range ပါ ပါသွားအောင်)
    const originHeaders = new Headers();
    if (rangeHeader) {
      originHeaders.set("Range", rangeHeader);
    }

    // aws4fetch က request ကို sign လုပ်ပြီး fetch ပြန်ပေးပါတယ်။
    const signedRequest = await aws.sign(originUrl, {
      method: request.method,
      headers: originHeaders,
    });

    const originResponse = await fetch(signedRequest);

    // Origin က error ပြန်ရင် (404, 403 စသဖြင့်) တိုက်ရိုက် ပြန်ပေးပါတယ်။
    if (!originResponse.ok && originResponse.status !== 206) {
      return new Response(
        originResponse.status === 404 ? "File not found" : "Upstream error",
        { status: originResponse.status }
      );
    }

    // ---- Client သို့ ပြန်ပို့မယ့် response တည်ဆောက်ခြင်း ----
    const responseHeaders = new Headers();

    // Content-Type ကို file extension အလိုက် သတ်မှတ်ပါတယ်။
    responseHeaders.set("Content-Type", getContentType(objectKey, originResponse));

    // Streaming / seek အတွက် မရှိမဖြစ် headers
    responseHeaders.set("Accept-Ranges", "bytes");

    // Content-Length / Content-Range ကို origin ကနေ ကူးယူပါတယ်။
    copyHeader(originResponse, responseHeaders, "Content-Length");
    copyHeader(originResponse, responseHeaders, "Content-Range");
    copyHeader(originResponse, responseHeaders, "ETag");
    copyHeader(originResponse, responseHeaders, "Last-Modified");

    // CDN / browser cache (၁ ရက် စသဖြင့် ချိန်ညှိနိုင်ပါတယ်)
    responseHeaders.set("Cache-Control", "public, max-age=86400");

    responseHeaders.set("X-Cache", "MISS");

    response = new Response(originResponse.body, {
      status: originResponse.status, // 200 (full) သို့မဟုတ် 206 (partial)
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });

    // ---- Cache ထဲ သိမ်းခြင်း ----
    // 200 (full file) နဲ့ 206 (range) နှစ်မျိုးလုံးကို cache လုပ်ပါတယ်။
    // waitUntil သုံးတဲ့အတွက် response ကို client ဆီ ချက်ချင်း ပြန်ပေးနိုင်ပါတယ်။
    if (request.method === "GET" &&
        (response.status === 200 || response.status === 206)) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }

    return response;
  },
};

// ---- Helper functions ----

function copyHeader(from, toHeaders, name) {
  const value = from.headers.get(name);
  if (value !== null) {
    toHeaders.set(name, value);
  }
}

function getContentType(key, originResponse) {
  // Origin က မှန်ကန်တဲ့ content-type ပေးထားရင် အဲဒါကို သုံးပါ
  const originType = originResponse.headers.get("Content-Type");
  if (originType && originType !== "application/octet-stream") {
    return originType;
  }

  const ext = key.split(".").pop().toLowerCase();
  const map = {
    mp4: "video/mp4",
    m4v: "video/x-m4v",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    ts: "video/mp2t",
    m3u8: "application/vnd.apple.mpegurl",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  return map[ext] || "application/octet-stream";
}
