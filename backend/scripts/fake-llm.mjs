// Fake OpenAI-compatible LLM for load testing: streams ~25 chunks over ~1s, like a real model.
import http from "node:http";
const port = Number(process.env.PORT ?? 9999);
const words = "Honestly that sounds like a schedule thing rather than interest. Watch whether he asks questions back and suggests meeting. Draft: \"Drinks Thursday?\"".split(" ");
http
  .createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const t = setInterval(() => {
        if (i < words.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] + " " } }] })}\n\n`);
        } else {
          clearInterval(t);
          res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 350, completion_tokens: 60 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        }
      }, 40);
      res.on("close", () => clearInterval(t));
    });
  })
  .listen(port, () => console.log(`fake LLM on :${port}`));
