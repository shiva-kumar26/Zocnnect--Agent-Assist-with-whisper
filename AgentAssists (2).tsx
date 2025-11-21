

import React, { useContext, useEffect, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { AuthContext } from "@/store/AuthContext";
import { CallContext } from "@/components/calls/CallProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Phone, FileText, Smile, BarChart3, BookOpen } from "lucide-react";

type SentimentType = string | { label: string; score?: number };
type TranscriptMessage = {
  speaker: "Agent" | "Customer";
  text: string;
  time?: string;
  sentiment?: SentimentType;
};

const STORAGE_KEY = "AgentAssists:activeCallData";
// How long after receiving post-call summary to keep showing it before clearing session storage (ms)
const CLEAR_AFTER_SUMMARY_MS = 5000;

/**
 * AgentAssists.tsx
 *
 * Full drop-in file: keeps all your existing live transcript, sentiment analysis,
 * sentiment distribution and post-call summary UI/logic, and **adds**:
 *  - Editable Post-Call Summary textarea (Edit / Save / Cancel)
 *  - Save to localStorage keyed by customer phone number (customerSummaries)
 *  - Load stored customer summary when activeCallDetails.number becomes available
 *
 * NOTE: This file intentionally uses plain <button> elements so it doesn't require
 * any additional custom Button components. All original UI layout/structure preserved.
 */

export default function AgentAssists() {
  const { auth } = useContext(AuthContext);
  // CallContext should provide activeCallDetails including number (phone)
  const { activeCallDetails } = useContext(CallContext);
  const wsRef = useRef<WebSocket | null>(null);

  // core UI state
  const [liveTranscript, setLiveTranscript] = useState<TranscriptMessage[]>([]);
  const [keyPhrases, setKeyPhrases] = useState<string[]>([]);
  const [postCallSummary, setPostCallSummary] = useState<string>("");
  const [sentimentChartData, setSentimentChartData] = useState<{ name: string; value: number }[]>([]);
  const [sentimentScore, setSentimentScore] = useState<number>(0);
  const [sentimentLabel, setSentimentLabel] = useState<string>("No Data");
  const [currentPartial, setCurrentPartial] = useState<{ speaker: string; text: string } | null>(null);


  // call lifecycle flags
  const [isCallActive, setIsCallActive] = useState<boolean>(false);
  const [isPostCallComplete, setIsPostCallComplete] = useState<boolean>(false);

  // editable summary states
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editableSummary, setEditableSummary] = useState<string>("");

  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const sentimentIdxRef = useRef<number>(0);
  const summaryClearTimeoutRef = useRef<number | null>(null);

  // --------------------------
  // Session storage helpers
  // --------------------------
  const saveToSession = () => {
    const payload = {
      liveTranscript,
      keyPhrases,
      postCallSummary,
      sentimentChartData,
      sentimentScore,
      sentimentLabel,
      isCallActive,
      isPostCallComplete,
    };
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      // ignore storage errors
      console.warn("Failed to save session", e);
    }
  };

  const loadFromSession = () => {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const data = JSON.parse(raw);
      setLiveTranscript(data.liveTranscript || []);
      setKeyPhrases(data.keyPhrases || []);
      setPostCallSummary(data.postCallSummary || "");
      setEditableSummary(data.postCallSummary || "");
      setSentimentChartData(data.sentimentChartData || []);
      setSentimentScore(typeof data.sentimentScore === "number" ? data.sentimentScore : 0);
      setSentimentLabel(data.sentimentLabel || "No Data");
      setIsCallActive(!!data.isCallActive);
      setIsPostCallComplete(!!data.isPostCallComplete);
      // set sentimentIdxRef to last index for proper continuation
      if (Array.isArray(data.sentimentChartData) && data.sentimentChartData.length > 0) {
        const last = data.sentimentChartData[data.sentimentChartData.length - 1];
        const parsed = Number(last?.name);
        sentimentIdxRef.current = Number.isFinite(parsed) ? parsed : data.sentimentChartData.length;
      }
    } catch (e) {
      // corrupted session: remove it
      console.warn("Failed to parse saved session, clearing it.", e);
      sessionStorage.removeItem(STORAGE_KEY);
    }
  };

  const clearSession = () => {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      // ignore
    }
  };

  // --------------------------
  // Sentiment helpers
  // --------------------------
  // Normalizes label/score into value between 0..1 for chart:
  // Negative ~ 0, Neutral ~ 0.5, Positive ~ 1.
  const normalizeSentiment = (label?: string, score?: number) => {
    const s = typeof score === "number" ? score : 0.5;
    const l = (label || "").toLowerCase();
    if (l === "positive") return Math.min(1, 0.5 + s / 2);
    if (l === "negative") return Math.max(0, 0.5 - s / 2);
    return 0.5;
  };

  // Try to map numeric sentiment from backend (e.g. 0.127) to label + score.
  // We'll consider numeric value in [-1,1] or [0,1]. If 0..1 => treat as negative->positive with 0.5 neutral pivot.
  const mapNumericSentimentToLabelScore = (num?: number): { label: string; score?: number } => {
    if (typeof num !== "number" || Number.isNaN(num)) return { label: "Neutral", score: 0.5 };

    // If value in [-1,1], map to label + score in [0..1], where 0.5 neutral.
    // Many backends produce 0..1 small positive => treat 0.5 neutral
    if (num >= -1 && num <= 1) {
      // treat num as -1..1 or 0..1; if max <=1 and min>=0 assume 0..1
      if (num >= 0 && num <= 1) {
        // 0 => very negative, 0.5 => neutral, 1 => very positive
        const score = Math.abs(num - 0.5) * 2; // 0..1 strength
        if (num < 0.5) return { label: "Negative", score };
        if (num > 0.5) return { label: "Positive", score };
        return { label: "Neutral", score: 0.5 };
      } else {
        // assume -1..1
        const score = Math.abs(num);
        if (num < 0) return { label: "Negative", score };
        if (num > 0) return { label: "Positive", score };
        return { label: "Neutral", score: 0.5 };
      }
    }
    // fallback
    return { label: "Neutral", score: 0.5 };
  };

  // --------------------------
  // Load on first mount
  // --------------------------
  useEffect(() => {
    loadFromSession();
  }, []);

  // --------------------------
  // Persist when necessary
  // Keep session while call is active OR waiting to show summary
  // --------------------------
  useEffect(() => {
    if (isCallActive || !isPostCallComplete) {
      saveToSession();
    }
    // we intentionally include all dependents that form the persisted snapshot
  }, [
    liveTranscript,
    keyPhrases,
    postCallSummary,
    sentimentChartData,
    sentimentScore,
    sentimentLabel,
    isCallActive,
    isPostCallComplete,
  ]);

  // --------------------------
  // Load stored customer summary when customer number available
  // This allows showing previous summary when the same customer calls again
  // --------------------------
  useEffect(() => {
    try {
      if (activeCallDetails?.number) {
        const summaries = JSON.parse(localStorage.getItem("customerSummaries") || "{}");
        const stored = summaries[activeCallDetails.number];
        if (stored && !postCallSummary) {
          // only set if we don't already have a fresh postCallSummary for current call
          setPostCallSummary(stored);
          setEditableSummary(stored);
          // do not auto-enter editing mode; agent can press Edit if needed
        }
      }
    } catch (err) {
      // ignore
    }
    // run whenever activeCallDetails.number changes
  }, [activeCallDetails?.number]);

  // --------------------------
  // WebSocket: connect and handle messages
  // --------------------------
  useEffect(() => {
    if (!auth) return;
    const agentId = (auth as any).agentId || (auth as any).userId;
    if (!agentId) return;

    const WEBSOCKET_URL = `wss://10.16.7.130:2700/transcripts?agentId=${agentId}`;
    console.log("WebSocket connecting for agentId:", agentId);

    const ws = new WebSocket(WEBSOCKET_URL);
    wsRef.current = ws;

    ws.onopen = () => console.log("WebSocket connected for agentId:", agentId);

    ws.onmessage = (event) => {
      try {
        const text = (event.data || "").toString().trim();
        if (!text) return;
        if (text.startsWith("<!DOCTYPE")) {
          console.error("Received HTML instead of JSON:", text);
          return;
        }
        const data = JSON.parse(text);

        // ----- call_start: reset everything and start fresh for new call -----
        if (data.type === "call_start") {
          // clear any previous persisted data and flags
          clearSession();
          if (summaryClearTimeoutRef.current) {
            window.clearTimeout(summaryClearTimeoutRef.current);
            summaryClearTimeoutRef.current = null;
          }

          setIsCallActive(true);
          setIsPostCallComplete(false);
          setLiveTranscript([]);
          setKeyPhrases([]);
          setPostCallSummary("");
          setEditableSummary("");
          setSentimentChartData([]);
          setSentimentScore(0.5);
          setSentimentLabel("Neutral");
          sentimentIdxRef.current = 0;
          return;
        }

        // ----- call_end: mark call ended but keep session until summary arrives -----
        if (data.type === "call_end") {
          setIsCallActive(false);
          // do not clear anything here — we want to wait for post-call summary
          return;
        }

        // It's possible messages come as array or single object
        const messages = Array.isArray(data) ? data : [data];
        // --- HANDLE PARTIAL TRANSCRIPTS ---
        messages
          .filter((m: any) => m.type === "transcript" && m.message_type === "partial")
          .forEach((m: any) => {
             const speaker = m.speaker || "Speaker";
             const text = m.partial || "";

             setCurrentPartial({
                speaker,
                text
              });

       });


        // ----- Transcript processing -----
        const mappedTranscripts: TranscriptMessage[] = [];
        messages
          .filter((m: any) => m && m.type === "transcript" && m.message_type === "final")
          .forEach((m: any) => {
            const speaker = m.speaker === "Agent" ? "Agent" : "Customer";
            const text = m.final || m.text || "";
            const time = m.timestamp ? new Date(Number(m.timestamp) * 1000).toLocaleTimeString() : undefined;
            const sentiment = m.sentiment;
            const last = mappedTranscripts[mappedTranscripts.length - 1];
            if (last && last.speaker === speaker) {
              last.text += " " + text;
              last.time = time;
              last.sentiment = sentiment;
            } else {
              mappedTranscripts.push({ speaker, text, time, sentiment });
            }
          });

        if (mappedTranscripts.length > 0) {
          // merge into liveTranscript state (preserve across tab changes because we persist)
          setLiveTranscript((prev) => {
            const updated = [...prev];
            mappedTranscripts.forEach((msg) => {
              const last = updated[updated.length - 1];
              if (last && last.speaker === msg.speaker) {
                last.text += " " + msg.text;
                last.time = msg.time;
                last.sentiment = msg.sentiment;
              } else {
                updated.push(msg);
              }
            });
            return updated;
          });

          // update sentiment chart using latest mapped message
          const latest = mappedTranscripts[mappedTranscripts.length - 1];
          let label = "";
          let score: number | undefined;
          if (typeof latest.sentiment === "string") label = latest.sentiment;
          else if (latest.sentiment && typeof latest.sentiment === "object") {
            label = latest.sentiment.label;
            score = latest.sentiment.score;
          } else if (typeof latest.sentiment === "number") {
            const m = mapNumericSentimentToLabelScore(latest.sentiment as number);
            label = m.label;
            score = m.score;
          }

          const val = normalizeSentiment(label, score);
          setSentimentScore(val);
          setSentimentLabel(label || "Neutral");
          setSentimentChartData((prev) => {
            const idx = sentimentIdxRef.current + 1;
            sentimentIdxRef.current = idx;
            const next = [...prev, { name: String(idx), value: val }];
            return next.length > 9 ? next.slice(next.length - 9) : next;
          });
        }

        // ----- Key Phrases (some messages may include topics/keywords) -----
        const topicsMsg =
          messages.find((m: any) => m && m.type === "key_topics" && Array.isArray(m.topics)) ||
          messages.find((m: any) => m && m.type === "transcript" && Array.isArray(m.keyphrases));
        if (topicsMsg) {
          setKeyPhrases(topicsMsg.topics || topicsMsg.keyphrases || []);
        }

        // ----- Post-call summary (example format you gave) -----
        // {
        //   "type":"summary",
        //   "call_id":"....",
        //   "summary":"The customer ...",
        //   "keywords":["customer","agent"],
        //   "sentiment":0.127
        // }
        const summaryMsg = messages.find((m: any) => m && (m.type === "summary" || m.type === "post_call") && (m.summary || m.keywords || typeof m.sentiment !== "undefined"));
        if (summaryMsg) {
          // summary text
          const summaryText = summaryMsg.summary || "";
          // use centralized handler so we also save to localStorage by phone number
          handlePostCallSummary(summaryText);

          // keywords -> keyPhrases
          if (Array.isArray(summaryMsg.keywords)) {
            setKeyPhrases(summaryMsg.keywords);
          } else if (Array.isArray(summaryMsg.keyphrases)) {
            setKeyPhrases(summaryMsg.keyphrases);
          }

          // numeric sentiment from summary -> update gauge
          if (typeof summaryMsg.sentiment === "number") {
            const mapped = mapNumericSentimentToLabelScore(summaryMsg.sentiment);
            const normalizedVal = normalizeSentiment(mapped.label, mapped.score);
            setSentimentScore(normalizedVal);
            setSentimentLabel(mapped.label || "Neutral");
            setSentimentChartData((prev) => {
              const idx = sentimentIdxRef.current + 1;
              sentimentIdxRef.current = idx;
              const next = [...prev, { name: String(idx), value: normalizedVal }];
              return next.length > 9 ? next.slice(next.length - 9) : next;
            });
          }

          // mark post call complete and schedule clearing session so page refresh won't keep active call state
          setIsPostCallComplete(true);

          // clear previous timeout if set
          if (summaryClearTimeoutRef.current) {
            window.clearTimeout(summaryClearTimeoutRef.current);
            summaryClearTimeoutRef.current = null;
          }

          // allow a short delay for users to view the post-call summary, then clear session storage
          summaryClearTimeoutRef.current = window.setTimeout(() => {
            clearSession();
            // keep UI visible for the current render — optionally you could clear the UI state as well
            // Here we keep postCallSummary visible for the user that is still on the page,
            // but we remove persisted session so a refresh won't rehydrate it as 'active call'.
            summaryClearTimeoutRef.current = null;
          }, CLEAR_AFTER_SUMMARY_MS);
        }
      } catch (e) {
        console.error("Invalid JSON in WebSocket message or other parse error:", e, event.data);
      }
    };

    ws.onerror = (err) => {
      console.error("WebSocket error:", err);
    };

    ws.onclose = (ev) => {
      console.log("WebSocket closed", ev?.code, ev?.reason);
      // don't clear session here — we rely on call lifecycle messages for clearing
    };

    return () => {
      // cleanup ws on unmount/reconnect
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
      wsRef.current = null;
    };
    // only re-run when auth changes
  }, [auth, activeCallDetails?.number]); // include number so we can save with phone context

  // --------------------------
  // Scroll transcript into view when updated
  // --------------------------
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [liveTranscript]);

  // --------------------------
  // If user refreshes page and session contains only finished post-call (no active call),
  // clear it immediately (so refresh doesn't show stale active-call data)
  // --------------------------
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      // if saved state indicates no active call and post call is complete => clear persisted and reset UI
      if (!data.isCallActive && data.isPostCallComplete) {
        clearSession();
        setLiveTranscript([]);
        setKeyPhrases([]);
        setPostCallSummary("");
        setSentimentChartData([]);
        setSentimentScore(0);
        setSentimentLabel("No Data");
        setIsCallActive(false);
        setIsPostCallComplete(false);
      }
    } catch {
      clearSession();
    }
    // run once on mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------------------------
  // Derived values for Sentiment Distribution UI
  // --------------------------
  const computeDistributionForSpeaker = (speaker: "Agent" | "Customer") => {
    const scores: number[] = liveTranscript
      .filter((m) => m.speaker === speaker && m.sentiment)
      .map((msg) => {
        if (typeof msg.sentiment === "string") {
          if (msg.sentiment === "Positive") return 0.9;
          if (msg.sentiment === "Negative") return 0.1;
          return 0.5;
        } else if (typeof msg.sentiment === "object") {
          if (typeof msg.sentiment.score === "number") {
            // message.score maybe in [-1,1] or [0,1] — normalize to 0..1
            const s = msg.sentiment.score;
            if (s >= 0 && s <= 1) return (s + 1) / 2; // map 0..1 -> 0.5..1 (approx) but safest approach:
            return (s + 1) / 2;
          }
        } else if (typeof msg.sentiment === "number") {
          // numeric sentiment on message
          const mapped = mapNumericSentimentToLabelScore(msg.sentiment);
          return normalizeSentiment(mapped.label, mapped.score);
        }
        return 0.5;
      });

    const total = scores.length || 0;
    const neg = scores.filter((s) => s <= 0.33).length;
    const neu = scores.filter((s) => s > 0.33 && s < 0.66).length;
    const pos = scores.filter((s) => s >= 0.66).length;
    return {
      total,
      neg,
      neu,
      pos,
      negPct: total === 0 ? 0 : (neg / total) * 100,
      neuPct: total === 0 ? 0 : (neu / total) * 100,
      posPct: total === 0 ? 0 : (pos / total) * 100,
    };
  };

  const customerDist = computeDistributionForSpeaker("Customer");
  const agentDist = computeDistributionForSpeaker("Agent");
  const lastAgentIndex = liveTranscript.map(m => m.speaker).lastIndexOf("Agent");
  const lastCustomerIndex = liveTranscript.map(m => m.speaker).lastIndexOf("Customer");

  // --------------------------
  // Post-call summary helpers (save to localStorage keyed by phone)
  // --------------------------
 // --------------------------
// Post-call summary helpers (save via API instead of localStorage)
// --------------------------
const handlePostCallSummary = async (summaryText: string) => {
  setPostCallSummary(summaryText);
  setEditableSummary(summaryText);

  try {
    if (activeCallDetails?.number) {
      const response = await fetch(
        `/api/update-summary/${encodeURIComponent(activeCallDetails.number)}?summary=${encodeURIComponent(summaryText)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        console.error("Failed to update summary:", await response.text());
      } else {
        console.log("Summary successfully saved via API");
      }
    } else {
      console.warn("No active customer number found; cannot save summary");
    }
  } catch (err) {
    console.error("Error updating summary:", err);
  }
};

const handleSaveSummary = async () => {
  setPostCallSummary(editableSummary);
  setIsEditing(false);

  try {
    if (activeCallDetails?.number) {
      const response = await fetch(
        `/api/update-summary/${encodeURIComponent(activeCallDetails.number)}?summary=${encodeURIComponent(editableSummary)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        console.error("Failed to update edited summary:", await response.text());
      } else {
        console.log("Edited summary saved via API");
      }
    } else {
      console.warn("No active customer number found; cannot save edited summary");
    }
  } catch (err) {
    console.error("Error saving edited summary:", err);
  }
};


  const handleCancelEdit = () => {
    setEditableSummary(postCallSummary);
    setIsEditing(false);
  };

  // --------------------------
  // Render
  // --------------------------
  return (
    <Card className="bg-white h-full flex flex-col shadow-lg border-slate-200 m-6">
      <CardHeader className="flex-shrink-0 border-b border-slate-100 bg-slate-50/50">
        <CardTitle className="flex items-center gap-3 text-xl text-slate-800">
          <Phone className="text-blue-600" /> Inbound Call
        </CardTitle>
      </CardHeader>

      <CardContent className="p-2 flex-1 flex flex-col min-h-0">
        <div className="flex-1 p-6 min-h-0 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1.7fr] gap-4 h-full">
            {/* Left: Transcript */}
            <div className="flex flex-col h-full">
              {/* ---- Live Call Transcription ---- */}
              <Card className="rounded-2xl shadow border border-slate-200 flex-1 flex flex-col min-h-0">
                <CardHeader className="bg-slate-50 border-b border-slate-200 rounded-t-2xl px-6 py-4">
                  <CardTitle className="flex items-center gap-2 text-slate-800 text-lg font-semibold">
                    <FileText className="text-blue-600 w-5 h-5" />
                    Live Call Transcription
                    <span className="ml-auto text-xs text-gray-400 font-medium">
                      (Total {liveTranscript.length} messages)
                    </span>
                  </CardTitle>
                </CardHeader>

                <CardContent className="px-4 py-3 flex-1 flex flex-col">
                  <div
                    className="flex flex-col gap-3 overflow-y-auto flex-1 px-1"
                    style={{ height: "288px", maxHeight: "426px" }}
                  >
                    {liveTranscript.length === 0 ? (
                      <div className="text-center text-slate-400 text-sm mt-16">
                        No transcript yet.
                      </div>
                    ) : (
                      
                      liveTranscript.map((msg, idx) => {
                        let sentimentText = "";
                        let sentimentScoreNum: number | undefined;
                        if (msg.sentiment) {
                          if (typeof msg.sentiment === "string") sentimentText = msg.sentiment;
                          else if (typeof msg.sentiment === "object") {
                            sentimentText = msg.sentiment.label;
                            sentimentScoreNum = msg.sentiment.score;
                          } else if (typeof msg.sentiment === "number") {
                            sentimentText =
                              msg.sentiment > 0 ? "Positive" : msg.sentiment < 0 ? "Negative" : "Neutral";
                            sentimentScoreNum = Math.abs(msg.sentiment);
                          }
                        }

                        const label = sentimentText.toLowerCase();
                        const dotColor =
                          label === "positive"
                            ? "bg-green-400"
                            : label === "negative"
                            ? "bg-red-400"
                            : "bg-yellow-400";
                        const textColor =
                          label === "positive"
                            ? "text-green-700"
                            : label === "negative"
                            ? "text-red-700"
                            : "text-yellow-700";

                        const isAgent = msg.speaker === "Agent";

                        return (
                          <div key={idx} className={`flex ${isAgent ? "justify-end" : "justify-start"}`}>
                            <div
                              className={`p-4 max-w-[75%] rounded-2xl shadow-sm border border-slate-200 ${
                                isAgent ? "bg-blue-50 rounded-tr-none" : "bg-white rounded-tl-none"
                              }`}
                            >
                              <div className="flex items-center justify-between mb-1">
                                <span className="font-semibold text-slate-700">{msg.speaker}</span>
                                <span className="text-xs text-slate-400">{msg.time}</span>
                              </div>

                            <div className="text-slate-700 text-sm leading-relaxed whitespace-pre-wrap">
  {msg.text}

  {/* SHOW PARTIAL LIVE TEXT INSIDE THE SAME BUBBLE */}
  {currentPartial &&
    currentPartial.speaker === msg.speaker && 
    idx === liveTranscript.length - 1 && (
      <span className="text-gray-400 italic"> {currentPartial.text}</span>
    )}
</div>


                              {sentimentText && (
                                <div className="flex items-center gap-1 text-xs mt-2">
                                  <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                                  <span className={`${textColor} font-medium`}>
                                    {label}{" "}
                                    {sentimentScoreNum !== undefined ? `(${sentimentScoreNum.toFixed(3)})` : ""}
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                    

                    <div ref={transcriptEndRef} />
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Right: Sentiment Chart + Key Phrases + Distribution */}
            <div className="flex flex-col gap-4 h-full">
              {/* Sentiment Analysis */}
              <Card className="rounded-2xl shadow border border-slate-200">
                <CardHeader className="bg-slate-50 border-b border-slate-200 rounded-t-2xl px-4 py-3">
                  <CardTitle className="flex items-center gap-2 text-slate-800 text-base font-semibold">
                    <BarChart3 className="text-blue-600 w-5 h-5" /> Sentiment Analysis
                  </CardTitle>
                </CardHeader>

                <CardContent className="p-4 bg-white">
                  <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
                    {/* Line Chart */}
                    <div className="flex-1 min-w-0">
                      {sentimentChartData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={120}>
                          <LineChart data={sentimentChartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="6 6" stroke="#e5e7eb" />
                            <XAxis dataKey="name" axisLine={false} tickLine={false} />
                            <YAxis
                              domain={[0, 1]}
                              ticks={[0, 0.5, 1]}
                              axisLine={false}
                              tickLine={false}
                              width={70}
                              tickFormatter={(v) =>
                                v === 0 ? "Negative" : v === 0.5 ? "Neutral" : v === 1 ? "Positive" : ""
                              }
                            />
                            <Tooltip
                              formatter={(v: number) =>
                                v === 0 ? "Negative" : v === 0.5 ? "Neutral" : v === 1 ? "Positive" : `${(v * 100).toFixed(1)}%`
                              }
                            />
                            <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      ) : (
                        <div className="flex items-center justify-center text-gray-400 text-sm h-[120px]">No sentiment data yet</div>
                      )}
                    </div>

                    {/* Circular sentiment gauge */}
                    <div className="flex flex-col items-center justify-center min-w-[90px]">
                      <div className="relative w-20 h-20 flex items-center justify-center">
                        <svg className="w-full h-full rotate-[-90deg]" viewBox="0 0 56 56">
                          <circle cx="28" cy="28" r="25" fill="none" stroke="#e5e7eb" strokeWidth="5" />
                          <circle
                            cx="28"
                            cy="28"
                            r="25"
                            fill="none"
                            stroke="#2563eb"
                            strokeWidth="5"
                            strokeDasharray={2 * Math.PI * 25}
                            strokeDashoffset={(1 - (sentimentChartData.length > 0 ? sentimentScore : 0)) * 2 * Math.PI * 25}
                            strokeLinecap="round"
                          />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-lg font-bold text-blue-700">
                            {sentimentChartData.length === 0 ? "0.0%" : (sentimentScore * 100).toFixed(1) + "%"}
                          </span>
                          <span className="text-xs text-blue-700 font-semibold">
                            {sentimentChartData.length === 0 ? "No Data" : sentimentLabel}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Key Phrases */}
                  <div className="mt-4">
                    <h3 className="text-slate-800 font-semibold text-base mb-2">Key Phrases</h3>
                    <div className="flex flex-wrap gap-2">
                      {keyPhrases.map((phrase, idx) => (
                        <span key={idx} className="bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs font-medium border border-blue-200 shadow-sm">
                          {phrase}
                        </span>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Sentiment Distribution */}
              <Card className="rounded-2xl shadow border border-slate-200">
                <CardHeader className="bg-slate-50 border-b border-slate-200 rounded-t-2xl px-4 py-3">
                  <CardTitle className="flex items-center gap-2 text-slate-800 text-base font-semibold">
                    <Smile className="text-blue-600 w-5 h-5" /> Sentiment Distribution
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 py-3">
                  {(["Customer", "Agent"] as const).map((type) => {
                    const dist = type === "Customer" ? customerDist : agentDist;
                    return (
                      <div key={type} className="mb-4">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-gray-800 font-semibold">{type} Sentiment</span>
                          <span className="text-xs text-gray-500">Total: {dist.total}</span>
                        </div>

                        <div className="h-4 bg-gray-100 rounded-full w-full relative overflow-hidden">
                          <div className="h-4 bg-red-400 absolute left-0 top-0" style={{ width: `${dist.negPct}%` }} />
                          <div className="h-4 bg-yellow-400 absolute top-0" style={{ width: `${dist.neuPct}%`, left: `${dist.negPct}%` }} />
                          <div className="h-4 bg-green-400 absolute top-0" style={{ width: `${dist.posPct}%`, left: `${dist.negPct + dist.neuPct}%` }} />
                        </div>

                        <div className="flex justify-between text-xs text-gray-500 mt-1">
                          <span>Negative: {dist.neg}</span>
                          <span>Neutral: {dist.neu}</span>
                          <span>Positive: {dist.pos}</span>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Post Call Summary */}
          <Card className="rounded-2xl shadow border border-slate-200 mt-4 mb-4">
            <CardHeader className="bg-slate-50 border-b border-slate-200 rounded-t-2xl px-6 py-4">
              <CardTitle className="flex items-center gap-2 text-slate-800 text-base font-semibold">
                <BookOpen className="text-blue-600 w-5 h-5" /> Post Call Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 py-6">
              {isEditing ? (
                <div className="flex flex-col gap-4">
                  <textarea
                    className="w-full border border-slate-300 rounded-md p-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
                    rows={6}
                    value={editableSummary}
                    onChange={(e) => setEditableSummary(e.target.value)}
                  />
                  <div className="flex gap-3 justify-end">
                    <button
                      onClick={handleCancelEdit}
                      className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveSummary}
                      className="px-4 py-1.5 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="min-h-[120px] text-slate-700 text-sm leading-6 whitespace-pre-wrap">
                  {postCallSummary || "No summary available."}
                  {postCallSummary && (
                    <div className="flex justify-end mt-4">
                      <button
                        onClick={() => {
                          setEditableSummary(postCallSummary);
                          setIsEditing(true);
                        }}
                        className="px-3 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-md hover:bg-blue-100 text-xs"
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </CardContent>
    </Card>
  );
}


