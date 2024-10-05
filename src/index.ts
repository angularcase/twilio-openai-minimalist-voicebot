import dotenv from "dotenv-flow";
import express from "express";
import ExpressWs from "express-ws";
import config from "../config";
import log from "./logger";
import * as oai from "./openai";
import { OpenAIStreamMessage } from "./openai-types";
import * as twlo from "./twilio";
import type { CallStatus } from "./twilio-types";

dotenv.config();

const { app } = ExpressWs(express());
app.use(express.urlencoded({ extended: true })).use(express.json());

/****************************************************
 Twilio Voice Webhook Endpoints
****************************************************/
app.post("/incoming-call", async (req, res) => {
  const { CallSid, From, To } = req.body;
  log.twl.info(`incoming-call from ${From} to ${To}`);

  try {
    oai.createWebsocket(); // This demo only supports one call at a time. Hence the OpenAI websocket is a singleton.
    oai.ws.on("open", () => log.oai.info("openai websocket opened"));
    oai.ws.on("error", (err) => log.oai.error("openai websocket error", err));
    // The incoming-call webhook is blocked until the OpenAI websocket is connected.
    // This ensures Twilio's Media Stream doesn't send audio packets to OpenAI prematurely.
    await oai.wsPromise;

    res.status(200);
    res.type("text/xml");

    // The <Stream/> TwiML noun tells Twilio to send the call to the websocket endpoint below.
    res.end(`
        <Response>
          <Connect>
            <Stream url="wss://${process.env.HOSTNAME}/media-stream/${CallSid}" />
          </Connect>
        </Response>
        `);
  } catch (error) {
    log.oai.error(
      "incoming call webhook failed because OpenAI websocket could not connect."
    );
    res.status(500).send();
  }
});

app.post("/call-status-update", async (req, res) => {
  const status = req.body.CallStatus as CallStatus;

  if (status === "error") log.twl.error(`call-status-update ${status}`);
  else log.twl.info(`call-status-update ${status}`);

  if (status === "error" || status === "completed") oai.closeWebsocket();

  res.status(200).send();
});

/****************************************************
 Twilio Media Stream Websocket Endpoint 
****************************************************/
app.ws("/media-stream/:callSid", (ws, req) => {
  log.twl.info("incoming websocket");

  twlo.setWs(ws);
  twlo.ws.on("error", (err) => log.twl.error(`websocket error`, err));

  let callStartTime = Date.now();

  oai.ws.on("message", (data) => {
    const msg: OpenAIStreamMessage = JSON.parse(data.toString());

    if (["response.audio.delta"].includes(msg.type)) return;

    const elapsedMs = Date.now() - callStartTime;

    log.oai.debug(`elapsed: ${elapsedMs}`, msg);
  });

  // twilio media stream starts
  twlo.onMessage("start", (msg) => {
    log.twl.success("media stream started");
    twlo.setStreamSid(msg.streamSid);

    // The session params should probably be set when the OpenAI websocket is initialized
    // but, setting them slightly later (i.e. when the Twilio Media starts) seems to make
    // OpenAI's bot more responsive. I don't know why.
    oai.setSessionParams();

    oai.speak(config.openai.introduction); // tell OpenAI to speak the introduction
  });

  // relay audio packets between Twilio & OpenAI
  oai.onMessage("response.audio.delta", (msg) => twlo.sendAudio(msg.delta));
  twlo.onMessage("media", (msg) => oai.sendAudio(msg.media.payload));

  // user starts talking
  oai.onMessage("input_audio_buffer.speech_started", (msg) => {
    log.app.info("user started speaking");

    oai.clearAudio(); // tell OpenAI to stop sending audio
    twlo.clearAudio(); // tell Twilio to stop playing any audio that it has buffered
  });

  // handle truncation
  let curItem = "";
  oai.onMessage("conversation.item.created", (msg) => (curItem = msg.item.id));

  let lastStopMs = 0;
  oai.onMessage(
    "input_audio_buffer.speech_stopped",
    (msg) => (lastStopMs = msg.audio_end_ms)
  );

  oai.onMessage("input_audio_buffer.speech_started", (msg) => {
    if (!curItem.length) return;

    const elapsedMs = Date.now() - callStartTime;
    oai.truncate(curItem, elapsedMs - lastStopMs);
  });

  // bot final transcript
  oai.onMessage("response.audio_transcript.done", (msg) => {
    log.oai.info("bot transcript (final): ", msg.transcript);
  });
});

/****************************************************
 Start Server
****************************************************/
const port = process.env.PORT || "3000";
app.listen(port, () => {
  log.app.info(`server running on http://localhost:${port}`);
});

/****************************************************
 Audio content of 2500 samples is already shorter than 8896 samples
 Audio content of 2900 samples is already shorter than 3520 samples

****************************************************/
