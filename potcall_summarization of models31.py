
#!/usr/bin/env python3
"""
POST-CALL ANALYSIS SERVICE - PRODUCTION VERSION
Consumes transcripts from Kafka and generates AI summaries
"""

import json
import logging
import time
from collections import defaultdict
import requests
from kafka import KafkaConsumer, KafkaProducer
import spacy
import re
from keybert import KeyBERT
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
import asyncio
import psycopg2
import threading
import sys
import os
from concurrent.futures import ThreadPoolExecutor
import queue
import torch
import psutil
import logging
from typing import List, Dict
from datetime import datetime

from concurrent.futures import ThreadPoolExecutor

partial_summaries = defaultdict(list)
partial_summary_lock = threading.Lock()
summary_executor = ThreadPoolExecutor(max_workers=2)


# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("PostCallConsumer")

# === Configuration ===
KAFKA_BROKER = "10.16.7.62:9092"
TOPIC = "call_transcripts"
SUMMARY_TOPIC = "call_summaries"
CALL_TIMEOUT = 30
PROCESSING_TIMEOUT = 25
MAX_TEXT_LENGTH = 1024
CHUNK_SIZE = 600

# PostgreSQL Configuration
DB_HOST = "10.16.7.95"
DB_USER = "dbuser"
DB_PASSWORD = "Zeniusit123"
DB_NAME = "freeswitchcore"

def safe_deserializer(data):
    """Safe JSON deserializer that handles errors gracefully"""
    try:
        return json.loads(data.decode('utf-8'))
    except Exception as e:
        logger.warning(f"Failed to deserialize message: {e}")
        return None

# ✅ KAFKA PRODUCER SETUP (for sending summaries)
try:
    summary_producer = KafkaProducer(
        bootstrap_servers=[KAFKA_BROKER],
        value_serializer=lambda v: json.dumps(v).encode('utf-8'),
        request_timeout_ms=120000,
        max_block_ms=120000,
        metadata_max_age_ms=300000,
        connections_max_idle_ms=540000,
        retries=5,
        linger_ms=10,
        acks='all',
        delivery_timeout_ms=180000,
        batch_size=16384,
        compression_type='gzip'
    )
    logger.info("✓ Kafka summary producer initialized")
except Exception as e:
    logger.error(f"✗ Failed to initialize Kafka summary producer: {e}")
    raise

# ✅ KAFKA CONSUMER SETUP (for receiving transcripts)
def initialize_consumer():
    """Initialize Kafka consumer with proper error handling"""
    try:
        consumer = KafkaConsumer(
            TOPIC,
            bootstrap_servers=[KAFKA_BROKER],
            value_deserializer=safe_deserializer,
            auto_offset_reset="latest",
            enable_auto_commit=True,
            group_id="optimized-call-consumer",
            max_poll_interval_ms=300000,
            session_timeout_ms=30000,
            heartbeat_interval_ms=10000,
            fetch_min_bytes=1,
            fetch_max_wait_ms=500
        )
        logger.info("✓ Kafka consumer initialized successfully")
        logger.info(f"Listening on topic {TOPIC}")
        return consumer
    except Exception as e:
        logger.error(f"✗ Failed to initialize Kafka consumer: {e}")
        raise

# Models and NLP
# ✅ LLaMA3 local model via Ollama
# === AI MODELS (via Ollama) ===
LLAMA_API_URL = "http://localhost:11434/api/generate"

# 🧩 Small fast model for mini summaries (during the call)
PHI_MODEL = "phi:latest"

# 🦙 Bigger accurate model for final summary (after call ends)
LLAMA_MODEL = "llama3:latest"

logger.info(f"✓ Mini summaries use: {PHI_MODEL}")
logger.info(f"✓ Final summaries use: {LLAMA_MODEL}")


logger.info("Loading NLP models...")
try:
    nlp = spacy.load("en_core_web_sm", disable=["parser"])
    logger.info("✓ spaCy model loaded")
except Exception as e:
    logger.error(f"✗ Failed to load spaCy: {e}")
    raise

try:
    kw_model = KeyBERT()
    logger.info("✓ KeyBERT model loaded")
except Exception as e:
    logger.error(f"✗ Failed to load KeyBERT: {e}")
    raise

try:
    sentiment_analyzer = SentimentIntensityAnalyzer()
    logger.info("✓ VADER sentiment analyzer loaded")
except Exception as e:
    logger.error(f"✗ Failed to load VADER: {e}")
    raise

# PostgreSQL connection pool
def get_db_connection():
    """Get a database connection"""
    try:
        conn = psycopg2.connect(
            host=DB_HOST,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME,
            connect_timeout=5
        )
        logger.debug("✓ Database connection established")
        return conn
    except Exception as e:
        logger.error(f"✗ Failed to connect to database: {e}")
        return None

def save_summary_to_db(call_id, agent_id, customer_id, summary_text, topics, sentiment_score):
    """Save summary to PostgreSQL"""
    try:
        conn = get_db_connection()
        if not conn:
            logger.warning(f"Could not save to DB - no connection for call {call_id}")
            return False
        
        cursor = conn.cursor()
        
        query = """
            INSERT INTO summaries (call_id, agent_id, customer_id, call_summary, topics, sentiment_score, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (call_id) DO UPDATE SET
                call_summary = EXCLUDED.call_summary,
                topics = EXCLUDED.topics,
                sentiment_score = EXCLUDED.sentiment_score,
                updated_at = NOW()
        """
        
        cursor.execute(query, (call_id, agent_id, customer_id, summary_text, json.dumps(topics), sentiment_score))
        conn.commit()
        cursor.close()
        conn.close()
        
        logger.info(f"✓ Summary saved to database for call {call_id}")
        return True
    except Exception as e:
        logger.error(f"✗ Failed to save summary to database: {e}")
        return False

def summarize_text(text: str, max_length: int = 150) -> str:
    """Generate summary using LLaMA3 via local API"""
    try:
        if not text or len(text.strip()) < 10:
            return "No significant content to summarize"

        # Split into chunks if text is too long
        chunks = []
        words = text.split()

        for i in range(0, len(words), CHUNK_SIZE):
            chunk = ' '.join(words[i:i + CHUNK_SIZE])
            chunks.append(chunk)

        # Summarize each chunk using local LLaMA model
        summaries = []
        for chunk in chunks[:5]:  # Limit to 5 chunks
            try:
                response = requests.post(
                    LLAMA_API_URL,
                    json={
                        "model": LLAMA_MODEL,
                        "prompt": f"Summarize the following call transcript in 2 to 3 clear and concise sentences focusing only on key points and actions:\n\n{chunk}\n\nSummary (2–3 sentences):",
                        "options": {"temperature": 0.4}
                    },
                    stream=True,
                    timeout=120
                )

                # Read the streamed response safely
                summary = ""
                for line in response.iter_lines():
                    if line:
                        try:
                            data = json.loads(line.decode("utf-8"))
                            if "response" in data:
                                summary += data["response"]
                        except json.JSONDecodeError:
                            continue

                summary = summary.strip()
                if summary:
                    summaries.append(summary)
                else:
                    logger.warning("Empty summary chunk received.")

            except Exception as e:
                logger.warning(f"Failed to summarize chunk: {e}")
                continue

        if not summaries:
            return "Unable to generate summary"

        # Combine summaries
        final_summary = " ".join(summaries)
        
        sentences = re.split(r'(?<=[.!?]) +', final_summary)
        final_summary = " ".join(sentences[:3])

        return final_summary if final_summary else "Summary generation completed but returned empty"

    except Exception as e:
        logger.error(f"✗ Error in summarize_text: {e}")
        return f"Error generating summary: {str(e)}"

def summarize_partial_chunk(text: str) -> str:
    """Generate a very short background summary for a small transcript chunk"""
    try:
        if not text or len(text.strip()) < 10:
            logger.debug(f"[MINI-SUMMARY] Text too short: {len(text)} chars")
            return ""
        
        logger.info(f"[MINI-SUMMARY] Generating partial summary for {len(text)} chars")
        
        response = requests.post(
            LLAMA_API_URL,
            json={
                "model": PHI_MODEL,
                "prompt": f"Summarize this part of the conversation in one short sentence:\n{text}\nSummary:",
                "options": {"temperature": 0.3, "num_predict": 80},
                "stream": False
            },
            timeout=30
        )
        
        # Check response status
        if response.status_code != 200:
            logger.warning(f"[MINI-SUMMARY] LLaMA returned status {response.status_code}")
            return ""
        
        # Parse response
        data = response.json()
        summary = data.get("response", "").strip()
        
        if summary:
            logger.info(f"[MINI-SUMMARY] ✓ Generated: {summary[:80]}...")
            return summary
        else:
            logger.warning(f"[MINI-SUMMARY] Empty response from LLaMA")
            return ""
            
    except requests.exceptions.Timeout:
        logger.warning(f"[MINI-SUMMARY] Timeout after 30s")
        return ""
    except Exception as e:
        logger.error(f"[MINI-SUMMARY] Error: {e}")
        return ""

def store_partial_summary(call_id, text):
    summary = summarize_partial_chunk(text)
    if summary:
        with partial_summary_lock:
            partial_summaries[call_id].append(summary)
        logger.debug(f"[MINI-SUMMARY] {call_id}: {summary}")

def extract_keywords(text: str) -> List[str]:
    """Extract keywords using KeyBERT"""
    try:
        if not text or len(text.strip()) < 10:
            return []
        
        keywords = kw_model.extract_keywords(text, top_n=5)
        return [kw[0] for kw in keywords]
    except Exception as e:
        logger.warning(f"Failed to extract keywords: {e}")
        return []

def analyze_call_sentiment(transcripts: Dict) -> float:
    """Analyze overall call sentiment"""
    try:
        if not transcripts:
            return 0.0
        
        all_text = []
        for speaker, messages in transcripts.items():
            for msg in messages:
                if isinstance(msg, dict) and 'text' in msg:
                    all_text.append(msg['text'])
                elif isinstance(msg, str):
                    all_text.append(msg)
        
        combined_text = " ".join(all_text)
        if not combined_text:
            return 0.0
        
        scores = sentiment_analyzer.polarity_scores(combined_text)
        return round(scores['compound'], 3)
    except Exception as e:
        logger.warning(f"Failed to analyze sentiment: {e}")
        return 0.0

def warm_up_with_transcript(event: Dict):
    """Silently process live transcript to warm up model"""
    try:
        call_id = event.get('call_id')
        text = event.get('text', '')
        speaker = event.get('speaker', '')
        
        if not text or len(text) < 5:
            return
        
        keywords = extract_keywords(text)
        logger.debug(f"[WARM-UP] {call_id} | {speaker}: {text[:50]}... | Keywords: {keywords}")
        
    except Exception as e:
        logger.debug(f"[WARM-UP] Error: {e}")

def format_transcripts(transcripts: Dict) -> str:
    """Format transcripts for summarization"""
    try:
        if not transcripts:
            return ""
        
        formatted = []
        
        # Try both dict and list formats
        if isinstance(transcripts, dict):
            for speaker, messages in transcripts.items():
                for msg in messages:
                    if isinstance(msg, dict) and 'text' in msg:
                        text = msg['text']
                    elif isinstance(msg, str):
                        text = msg
                    else:
                        continue
                    
                    formatted.append(f"{speaker}: {text}")
        else:
            formatted.append(str(transcripts))
        
        return "\n".join(formatted)
    except Exception as e:
        logger.error(f"Failed to format transcripts: {e}")
        return ""

def process_call_end_event(event: Dict):
    """Process a call end event and generate summary"""
    try:
        call_id = event.get('call_id')
        agent_id = event.get('agent_id')
        reason = event.get('reason', 'unknown')
        customer_id = event.get('customer_id')
        
        logger.info(f"🧠 Processing call end for {call_id} (Agent: {agent_id}, Customer: {customer_id}, Reason: {reason})")
        
        # Get transcripts
        transcripts = event.get('transcripts', {})
        
        if not transcripts:
            logger.warning(f"No transcripts found for call {call_id}")
            return
        
        # Format transcripts
        formatted_text = format_transcripts(transcripts)
        
        if not formatted_text or len(formatted_text) < 10:
            logger.warning(f"Formatted text too short for call {call_id}")
            return
        
        logger.info(f"📝 Processing {len(formatted_text)} characters of transcript")

        # ⚡ TIMING: Measure how fast summary generation is
        start_time = time.time()

        # Generate summary
        logger.info("🧠 Generating summary with LLaMA3...")
        summary = summarize_text(formatted_text)

        # Extract keywords
        logger.info("🔑 Extracting keywords...")
        keywords = extract_keywords(formatted_text)

        # Analyze sentiment
        logger.info("💬 Analyzing sentiment...")
        sentiment_score = analyze_call_sentiment(transcripts)

        elapsed_time = time.time() - start_time

        logger.info(f"")
        logger.info(f"✅ SUMMARY GENERATED IN {elapsed_time:.2f} SECONDS (Goal: 2-3 sec)")
        logger.info(f"")
        logger.info(f"📄 Summary:")
        logger.info(f"  {summary}")
        logger.info(f"")
        logger.info(f"🔑 Keywords: {', '.join(keywords)}")
        logger.info(f"💬 Sentiment Score: {sentiment_score}")
        logger.info(f"")
        
        # Save to database
        save_summary_to_db(call_id, agent_id, customer_id, summary, keywords, sentiment_score)
        
        # Send to Kafka (call_summaries topic)
        summary_event = {
            "call_id": call_id,
            "agent_id": agent_id,
            "customer_id": customer_id,
            "summary": summary,
            "keywords": keywords,
            "sentiment_score": sentiment_score,
            "generation_time_sec": round(elapsed_time, 2),
            "generated_at": datetime.now().isoformat(),
            "reason": reason
        }
        
        try:
            summary_producer.send(SUMMARY_TOPIC, summary_event)
            summary_producer.flush()
            logger.info(f"✅ Summary sent to Kafka topic {SUMMARY_TOPIC}")
            logger.info(f"{'='*60}")
            logger.info(f"")
        except Exception as e:
            logger.error(f"✗ Failed to send summary to Kafka: {e}")
        
    except Exception as e:
        logger.error(f"✗ Error processing call end event: {e}")

def main():
    """Main consumer loop"""
    logger.info("=" * 60)
    logger.info("POST-CALL ANALYSIS SERVICE STARTED")
    logger.info("=" * 60)
    logger.info(f"Kafka Broker: {KAFKA_BROKER}")
    logger.info(f"Input Topic: {TOPIC}")
    logger.info(f"Output Topic: {SUMMARY_TOPIC}")
    logger.info(f"Database: {DB_NAME}@{DB_HOST}")
    logger.info("=" * 60)
    
    consumer = initialize_consumer()
    # ✅ NEW: Track live transcripts for warm-up
    call_buffers = {}  # {call_id: [transcripts...]}
    call_timestamps = {}  # {call_id: last_seen_time}

    try:
        message_count = 0
        for message in consumer:
            try:
                if message.value is None:
                    logger.warning("Received None value from Kafka")
                    continue

                message_count += 1
                event = message.value
                call_id = event.get('call_id')

                # ---------- LIVE TRANSCRIPT (warm + buffer + partial mini-summary) ----------
                if event.get('status') != 'ended':
                    # ensure buffer exists
                    if call_id not in call_buffers:
                        call_buffers[call_id] = []

                    # Add transcript to buffer
                    call_buffers[call_id].append(event)
                    call_timestamps[call_id] = time.time()

                    # lightweight warm-up (keywords etc.)
                    warm_up_with_transcript(event)

                    # Every N messages produce a tiny partial summary in background
                    N = 5
                    if len(call_buffers[call_id]) % N == 0:
                        last_msgs = call_buffers[call_id][-N:]
                        combined_text = " ".join(m.get("text", "") for m in last_msgs if m.get("text"))
                        if combined_text.strip():
                            # spawn background thread to summarize the small chunk
                            summary_executor.submit(store_partial_summary, call_id, combined_text)


                    logger.debug(f"[MESSAGE {message_count}] Live transcript buffered for {call_id} ({len(call_buffers[call_id])} msgs)")

                # ---------- CALL END -> combine partials + buffer -> final summary ----------
                elif event.get('status') == 'ended':
                    logger.info(f"[MESSAGE {message_count}] 🔴 CALL END EVENT for {call_id}")
                    
                    # Pop buffered events safely
                    buffered_events = []
                    if call_id in call_buffers:
                        buffered_events = call_buffers.pop(call_id)
                        logger.info(f"[BUFFER] Using {len(buffered_events)} buffered transcripts for {call_id}")
                    
                    # Pop partial mini-summaries
                    with partial_summary_lock:
                        mini_summaries = partial_summaries.pop(call_id, [])
                    
                    logger.info(f"[PARTIAL] Found {len(mini_summaries)} partial summaries for {call_id}")
                    
                    # ✅ MAIN FIX: Use ONLY partial summaries if available
                    if mini_summaries:
                        logger.info(f"[SUMMARY] ✅ Using {len(mini_summaries)} partial summaries for final summary generation")
                        
                        # Combine partial summaries into one text
                        combined_partial_summaries = " ".join(ms for ms in mini_summaries if ms.strip())
                        
                        # Create event with combined partial summaries as input
                        final_event = {
                            "call_id": call_id,
                            "agent_id": event.get("agent_id"),
                            "customer_id": event.get("customer_id"),
                            "reason": event.get("reason", "unknown"),
                            "transcripts": {"Partial Summaries": [{"text": combined_partial_summaries}]}
                        }
                        
                        # Generate final summary from partial summaries
                        threading.Thread(target=process_call_end_event, args=(final_event,), daemon=True).start()
                        
                    else:
                        # Fallback: Use buffered text if no partial summaries
                        logger.warning(f"[SUMMARY] ⚠️ No partial summaries found for {call_id}, using buffered text")
                        
                        if buffered_events:
                            buffered_text = "\n".join(
                                f"{ev.get('speaker', '')}: {ev.get('text', '')}" 
                                for ev in buffered_events if ev.get('text')
                            )
                            
                            if buffered_text.strip():
                                final_event = {
                                    "call_id": call_id,
                                    "agent_id": event.get("agent_id"),
                                    "customer_id": event.get("customer_id"),
                                    "reason": event.get("reason", "unknown"),
                                    "transcripts": {"Live": [{"text": buffered_text}]}
                                }
                                threading.Thread(target=process_call_end_event, args=(final_event,), daemon=True).start()
                            else:
                                logger.warning(f"No text available to summarize for call {call_id}")
                        else:
                            # Last resort: use transcripts from event
                            transcripts = event.get('transcripts', {})
                            if transcripts:
                                threading.Thread(target=process_call_end_event, args=(event,), daemon=True).start()
                            else:
                                logger.warning(f"No text available to summarize for call {call_id}")
   
            except Exception as e:
                logger.error(f"✗ Error processing message: {e}")
                continue
    
    except KeyboardInterrupt:
        logger.info("Shutting down...")
    except Exception as e:
        logger.error(f"✗ Fatal error in main loop: {e}")
    finally:
        consumer.close()
        summary_producer.close()
        logger.info("Consumer and producer closed")

if __name__ == "__main__":
    main()
