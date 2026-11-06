import { useEffect, useState } from "react";
import { toast } from "sonner";

export interface TextSummary {
  id: string;
  token: string;
  title: string;
  lastAccessedAt: string;
}

export interface LocalText extends TextSummary {
  createdAt: string;
}

export const LOCAL_TEXTS_KEY = "w2w.texts.v1";
const changeEvent = "w2w:texts-changed";

function summary(text: TextSummary): TextSummary {
  // Text content and any server-only fields never enter browser history.
  return { id: text.id, token: text.token, title: text.title, lastAccessedAt: text.lastAccessedAt };
}

export function listLocalTexts(): LocalText[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_TEXTS_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value.flatMap((text: unknown) => {
      if (!text || typeof text !== "object") return [];
      const record = text as Partial<LocalText>;
      if (typeof record.id !== "string" || !/^[a-f\d-]{36}$/i.test(record.id)
        || typeof record.token !== "string" || !/^\d{1,6}$/.test(record.token)
        || typeof record.title !== "string" || typeof record.lastAccessedAt !== "string"
        || typeof record.createdAt !== "string" || seen.has(record.id)) return [];
      seen.add(record.id);
      return [{ ...summary(record as LocalText), createdAt: record.createdAt }];
    });
  } catch {
    return [];
  }
}

export function getLocalText(id: string) {
  return listLocalTexts().find((text) => text.id === id);
}

export function rememberText(text: TextSummary): LocalText {
  const texts = listLocalTexts();
  const index = texts.findIndex((entry) => entry.id === text.id);
  const record: LocalText = {
    ...summary(text),
    createdAt: index >= 0 ? texts[index].createdAt : new Date().toISOString(),
  };
  if (index < 0) texts.unshift(record);
  else texts[index] = record;
  try {
    localStorage.setItem(LOCAL_TEXTS_KEY, JSON.stringify(texts));
  } catch {
    const message = "This browser could not save your text history. Check its storage settings or free some space.";
    toast.error(message);
    throw new Error(message);
  }
  window.dispatchEvent(new Event(changeEvent));
  return record;
}

export function useLocalTexts() {
  const [texts, setTexts] = useState<LocalText[]>([]);
  useEffect(() => {
    const refresh = () => setTexts(listLocalTexts());
    refresh();
    window.addEventListener(changeEvent, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(changeEvent, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return texts;
}
