use serde_json::Value;

use super::config::ProviderKind;
use super::error::{AiError, AiResult};

const DEFAULT_MAX_LINE: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    Text(String),
    Done,
}

pub struct StreamParser {
    provider: ProviderKind,
    buffer: Vec<u8>,
    done: bool,
    max_line: usize,
}

impl StreamParser {
    pub fn new(provider: ProviderKind) -> Self {
        Self::with_max_line(provider, DEFAULT_MAX_LINE)
    }

    pub fn with_max_line(provider: ProviderKind, max_line: usize) -> Self {
        Self {
            provider,
            buffer: Vec::new(),
            done: false,
            max_line,
        }
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn feed(&mut self, chunk: &[u8]) -> AiResult<Vec<StreamEvent>> {
        self.buffer.extend_from_slice(chunk);
        if self.buffer.len() > self.max_line && !self.buffer.contains(&b'\n') {
            return Err(AiError::ResponseTooLarge);
        }
        let mut events = Vec::new();
        while let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=position).collect();
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.parse_line(&line, &mut events)?;
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> AiResult<Vec<StreamEvent>> {
        let mut events = Vec::new();
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            self.parse_line(&line, &mut events)?;
        }
        Ok(events)
    }

    fn parse_line(&mut self, raw: &[u8], events: &mut Vec<StreamEvent>) -> AiResult<()> {
        if raw.len() > self.max_line {
            return Err(AiError::ResponseTooLarge);
        }
        let line = std::str::from_utf8(raw)
            .map_err(|_| AiError::InvalidResponse)?
            .trim();
        if line.is_empty() || line.starts_with(':') {
            return Ok(());
        }
        if self.done {
            return Ok(());
        }
        match self.provider {
            ProviderKind::Ollama => self.parse_ollama(line, events),
            ProviderKind::OpenAiCompatible => self.parse_openai(line, events),
        }
    }

    fn parse_openai(&mut self, line: &str, events: &mut Vec<StreamEvent>) -> AiResult<()> {
        let payload = match line.strip_prefix("data:") {
            Some(rest) => rest.trim(),
            None => return Ok(()),
        };
        if payload == "[DONE]" {
            self.done = true;
            events.push(StreamEvent::Done);
            return Ok(());
        }
        let value: Value =
            serde_json::from_str(payload).map_err(|_| AiError::InvalidResponse)?;
        if value.get("error").is_some() {
            return Err(AiError::InvalidResponse);
        }
        if let Some(text) = value.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            if !text.is_empty() {
                events.push(StreamEvent::Text(text.to_string()));
            }
        }
        Ok(())
    }

    fn parse_ollama(&mut self, line: &str, events: &mut Vec<StreamEvent>) -> AiResult<()> {
        let value: Value = serde_json::from_str(line).map_err(|_| AiError::InvalidResponse)?;
        if value.get("error").is_some() {
            return Err(AiError::InvalidResponse);
        }
        if let Some(text) = value.pointer("/message/content").and_then(Value::as_str) {
            if !text.is_empty() {
                events.push(StreamEvent::Text(text.to_string()));
            }
        }
        if value.get("done").and_then(Value::as_bool).unwrap_or(false) {
            self.done = true;
            events.push(StreamEvent::Done);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect_openai(chunks: &[&str]) -> Vec<StreamEvent> {
        let mut parser = StreamParser::new(ProviderKind::OpenAiCompatible);
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(parser.feed(chunk.as_bytes()).expect("解析"));
        }
        events.extend(parser.finish().expect("收尾"));
        events
    }

    #[test]
    fn parses_fragmented_openai_stream() {
        let events = collect_openai(&[
            "data: {\"choices\":[{\"delta\":{\"cont",
            "ent\":\"你好\"}}]}\n\ndata: [DONE]\n\n",
        ]);
        assert_eq!(
            events,
            vec![StreamEvent::Text("你好".to_string()), StreamEvent::Done]
        );
    }

    #[test]
    fn ignores_comments_and_unknown_lines() {
        let events = collect_openai(&[
            ": ping\n\nevent: message\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\r\n",
        ]);
        assert_eq!(events, vec![StreamEvent::Text("a".to_string())]);
    }

    #[test]
    fn stops_after_done_marker() {
        let events = collect_openai(&[
            "data: [DONE]\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n\n",
        ]);
        assert_eq!(events, vec![StreamEvent::Done]);
    }

    #[test]
    fn parses_ollama_ndjson() {
        let mut parser = StreamParser::new(ProviderKind::Ollama);
        let mut events = parser
            .feed("{\"message\":{\"content\":\"嗨\"},\"done\":false}\n{\"done\":true}\n".as_bytes())
            .expect("解析");
        events.extend(parser.finish().expect("收尾"));
        assert_eq!(
            events,
            vec![StreamEvent::Text("嗨".to_string()), StreamEvent::Done]
        );
    }

    #[test]
    fn rejects_malformed_payload() {
        let mut parser = StreamParser::new(ProviderKind::OpenAiCompatible);
        assert!(matches!(
            parser.feed(b"data: not-json\n"),
            Err(AiError::InvalidResponse)
        ));
        let mut ollama = StreamParser::new(ProviderKind::Ollama);
        assert!(matches!(
            ollama.feed(b"{\"error\":\"boom\"}\n"),
            Err(AiError::InvalidResponse)
        ));
    }

    #[test]
    fn rejects_oversized_line() {
        let mut parser = StreamParser::with_max_line(ProviderKind::Ollama, 8);
        assert!(matches!(
            parser.feed(b"{\"message\":\"too-long\"}\n"),
            Err(AiError::ResponseTooLarge)
        ));
    }

    #[test]
    fn flushes_final_line_without_newline() {
        let events = collect_openai(&["data: {\"choices\":[{\"delta\":{\"content\":\"尾\"}}]}"]);
        assert_eq!(events, vec![StreamEvent::Text("尾".to_string())]);
    }
}
