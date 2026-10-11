// SmartRead – Front-end demo
const $ = (id) => document.getElementById(id);

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

let currentWord = "";
let currentFileUrl = null;
let isLookupInProgress = false;

// Cache so we never re-fetch a word we've already looked up successfully
const meaningCache = {};
$("pdfFile").addEventListener("change", function () {
  const file = this.files[0];
  $("fileName").textContent = file ? "Selected: " + file.name : "No PDF selected";
});

function startReading() {
  const input = $("pdfFile");
  if (!input.files.length) {
    alert("Please select a PDF first.");
    return;
  }

  const file = input.files[0];
  if (file.type !== "application/pdf") {
    alert("Please select a PDF file.");
    return;
  }

  if (currentFileUrl) URL.revokeObjectURL(currentFileUrl);
  currentFileUrl = URL.createObjectURL(file);

  $("home").classList.add("hidden");
  $("vocabularySection").classList.add("hidden");
  $("readerSection").classList.remove("hidden");
  $("documentTitle").textContent = file.name;

  displayPDF(currentFileUrl);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function displayPDF(url) {
  const viewer = $("pdfViewer");
  viewer.innerHTML = "<div class='hint'>Loading PDF…</div>";

  try {
    const pdf = await pdfjsLib.getDocument(url).promise;
    viewer.innerHTML = "";

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      await renderPage(pdf, pageNumber);
    }
  } catch (error) {
    console.error(error);
    viewer.innerHTML = "";
    const msg = document.createElement("div");
    msg.className = "hint";
    msg.textContent = "Unable to open this PDF. Please try another PDF.";
    viewer.appendChild(msg);
  }
}

async function renderPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const scale = window.innerWidth < 700 ? 1.15 : 1.5;
  const viewport = page.getViewport({ scale });

  const pageContainer = document.createElement("div");
  pageContainer.className = "pdf-page";
  pageContainer.style.width = `${viewport.width}px`;
  pageContainer.style.height = `${viewport.height}px`;
  $("pdfViewer").appendChild(pageContainer);

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  pageContainer.appendChild(canvas);

  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport
  }).promise;

  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  pageContainer.appendChild(textLayer);

    const textContent = await page.getTextContent();

  // Let PDF.js build the text layer so every word lines up exactly
  textLayer.style.setProperty("--scale-factor", scale);
  const textLayerTask = pdfjsLib.renderTextLayer({
    textContentSource: textContent,
    container: textLayer,
    viewport: viewport,
    textDivs: []
  });
  await textLayerTask.promise;

    // ===== Desktop: drag-selection (still works) =====
  textLayer.addEventListener("mouseup", function (event) {
    handleMouseSelection(event, textLayer);
  });

  // ===== Desktop: double-click a word (easier than dragging) =====
  textLayer.addEventListener("dblclick", function (event) {
    const word = getWordAtPoint(event.clientX, event.clientY, textLayer);
    if (word) {
      currentWord = word.toLowerCase();
      lookupWord(currentWord);
      window.getSelection()?.removeAllRanges();
    }
  });

  // ===== Mobile: double-tap-to-select =====
  attachDoubleTapHandler(textLayer);
}

// Desktop selection: only accept selections that start and end inside THIS text layer
function handleMouseSelection(event, textLayer) {
  setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;

    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !textLayer.contains(anchorNode)) return;
    if (!focusNode || !textLayer.contains(focusNode)) return;

    const rawText = selection.toString();
    const word = extractSingleWord(rawText);
    if (!word) return;

    currentWord = word;
    lookupWord(word);
  }, 80);
}

// Cleans selected text into a single valid word, rejecting multi-word drags
function extractSingleWord(rawText) {
  if (!rawText) return null;
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return null;
  if (/\s/.test(trimmed)) return null; // reject multi-word selections

  const cleaned = trimmed.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "");
  if (cleaned.length === 0) return null;
  if (!/^[a-zA-Z]+$/.test(cleaned)) return null;

  return cleaned.toLowerCase();
}

// ===== Mobile double-tap-to-select =====
function attachDoubleTapHandler(textLayer) {
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  textLayer.addEventListener("touchstart", function (event) {
    if (event.touches.length > 1) return;
    const touch = event.touches[0];
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartTime = Date.now();
  });

  textLayer.addEventListener("touchend", function (event) {
    const touch = event.changedTouches[0];
    const movedX = Math.abs(touch.clientX - touchStartX);
    const movedY = Math.abs(touch.clientY - touchStartY);
    const elapsed = Date.now() - touchStartTime;

    const isCleanTap = movedX < 10 && movedY < 10 && elapsed < 400;
    if (!isCleanTap) return;

    const now = Date.now();
    const timeSinceLastTap = now - lastTapTime;
    const distFromLastTap = Math.hypot(touch.clientX - lastTapX, touch.clientY - lastTapY);

    if (timeSinceLastTap < 350 && distFromLastTap < 30) {
      event.preventDefault();
      const word = getWordAtPoint(touch.clientX, touch.clientY, textLayer);
      if (word) {
        currentWord = word.toLowerCase();
        lookupWord(currentWord);
      }
      lastTapTime = 0;
    } else {
      lastTapTime = now;
      lastTapX = touch.clientX;
      lastTapY = touch.clientY;
    }
  });
}

// Finds the exact word under a screen coordinate, stitching across
// sibling <span> elements (PDF.js often splits one word into two spans).
function getWordAtPoint(x, y, textLayer) {
  let range;

  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
  }

  if (!range) return null;

  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) return null;
  if (!textLayer.contains(textNode)) return null;

  const text = textNode.textContent;
  let start = range.startOffset;
  let end = range.startOffset;

  while (start > 0 && /[a-zA-Z]/.test(text[start - 1])) start--;
  while (end < text.length && /[a-zA-Z]/.test(text[end])) end++;

  if (start === end) return null; // tapped a space or symbol

  // The tap must really be on top of this word
  const wordRange = document.createRange();
  wordRange.setStart(textNode, start);
  wordRange.setEnd(textNode, end);
  const tolerance = 4;
  const isOnWord = Array.from(wordRange.getClientRects()).some(function (r) {
    return x >= r.left - tolerance && x <= r.right + tolerance &&
           y >= r.top - tolerance && y <= r.bottom + tolerance;
  });
  if (!isOnWord) return null;

  let word = text.slice(start, end);

  if (start === 0) {
    const prevText = getAdjacentSpanText(textNode, -1);
    if (prevText) {
      const match = prevText.match(/[a-zA-Z]+$/);
      if (match) word = match[0] + word;
    }
  }

  if (end === text.length) {
    const nextText = getAdjacentSpanText(textNode, 1);
    if (nextText) {
      const match = nextText.match(/^[a-zA-Z]+/);
      if (match) word = word + match[0];
    }
  }

  return word.length > 0 ? word : null;
}

function getAdjacentSpanText(textNode, direction) {
  const currentSpan = textNode.parentElement;
  if (!currentSpan) return null;
  const sibling = direction === -1 ? currentSpan.previousElementSibling : currentSpan.nextElementSibling;
  if (!sibling) return null;
  return sibling.textContent || null;
}

// ===== Dictionary + Translation lookup =====

async function lookupWord(word) {
  if (isLookupInProgress) return; // ignore rapid repeated clicks while one is loading
  isLookupInProgress = true;

  $("selectedWord").textContent = word;
  $("meaningOverlay").classList.remove("hidden");
  updateSaveButton();

  // Use cached result if we already looked this word up successfully before
  if (meaningCache[word]) {
    $("englishMeaning").textContent = meaningCache[word].english;
    $("tamilMeaning").textContent = meaningCache[word].tamil;
    isLookupInProgress = false;
    return;
  }

  $("englishMeaning").textContent = "Finding meaning…";
  $("tamilMeaning").textContent = "தமிழ் அர்த்தம் தேடப்படுகிறது…";

  const english = await fetchEnglishMeaning(word);
  const tamil = await fetchTamilMeaning(word);

  $("englishMeaning").textContent = english;
  $("tamilMeaning").textContent = tamil;

  // Only cache successful results, not error messages, so we retry failures later
  const isEnglishError = english.startsWith("Meaning not found");
  const isTamilError = tamil.includes("unavailable") || tamil.includes("கிடைக்கவில்லை");

  if (!isEnglishError && !isTamilError) {
    meaningCache[word] = { english, tamil };
  }

  isLookupInProgress = false;
}

// Tries the primary dictionary first, falls back to Datamuse if it fails or times out
async function fetchEnglishMeaning(word) {
  try {
    const meaning = await fetchWithTimeout(
      "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word),
      8000
    ).then(res => {
      if (!res.ok) throw new Error("not found");
      return res.json();
    }).then(data => {
      const definitions = data[0]?.meanings?.flatMap(m => m.definitions || []) || [];
      const def = definitions[0]?.definition;
      if (!def) throw new Error("no definition");
      return def;
    });
    return meaning;
  } catch (primaryError) {
    console.warn("Primary dictionary failed, trying fallback:", primaryError);
    try {
      const fallbackMeaning = await fetchWithTimeout(
        "https://api.datamuse.com/words?sp=" + encodeURIComponent(word) + "&md=d&max=1",
        8000
      ).then(res => {
        if (!res.ok) throw new Error("fallback server error");
        return res.json();
      }).then(data => {
        if (!data || !data.length || !data[0].defs || !data[0].defs.length) {
          throw new Error("no fallback definition");
        }
                if (data[0].word.toLowerCase() !== word.toLowerCase()) {
          throw new Error("fallback returned a different word");
        }
        const raw = data[0].defs[0];
        const parts = raw.split("\t");
        return parts.length > 1 ? parts[1] : parts[0];
      });
      return fallbackMeaning;
    } catch (fallbackError) {
      console.error("Fallback dictionary also failed:", fallbackError);
      return "Meaning not found. Check the spelling or try another word.";
    }
  }
}

async function fetchTamilMeaning(word) {
  try {
    const response = await fetchWithTimeout(
      "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(word) + "&langpair=en|ta",
      8000
    );
    const data = await response.json();
    const translation = data?.responseData?.translatedText;
    return translation && translation.toLowerCase() !== word.toLowerCase()
      ? translation
      : "Tamil translation unavailable.";
  } catch (error) {
    console.error("Translation error:", error);
    return "தமிழ் மொழிபெயர்ப்பு கிடைக்கவில்லை.";
  }
}

// fetch() with a timeout, so a slow/down API fails fast instead of hanging
function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, { signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}

function hideMeaning() {
  $("meaningOverlay").classList.add("hidden");
  window.getSelection()?.removeAllRanges();
}

function closeMeaning(event) {
  if (event.target === $("meaningOverlay")) hideMeaning();
}

function speakWord(word = currentWord) {
  if (!word) return;
  window.speechSynthesis.cancel();
  const speech = new SpeechSynthesisUtterance(word);
  speech.lang = "en-US";
  window.speechSynthesis.speak(speech);
}

function getSavedWords() {
  return JSON.parse(localStorage.getItem("smartread_words") || "[]");
}

function saveCurrentWord() {
  if (!currentWord) return;

  const words = getSavedWords();
  const exists = words.some(item => item.word === currentWord);

  if (!exists) {
    words.push({
      word: currentWord,
      english: $("englishMeaning").textContent,
      tamil: $("tamilMeaning").textContent
    });
    localStorage.setItem("smartread_words", JSON.stringify(words));
  }

  updateSaveButton();
  renderVocabulary();
}

function updateSaveButton() {
  const words = getSavedWords();
  const exists = words.some(item => item.word === currentWord);
  $("saveBtn").textContent = exists ? "★ Saved" : "★ Save Word";
}

function showVocabulary() {
  $("home").classList.add("hidden");
  $("readerSection").classList.add("hidden");
  $("vocabularySection").classList.remove("hidden");
  renderVocabulary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderVocabulary() {
  const words = getSavedWords();
  $("wordCount").textContent = words.length;

  const list = $("savedWordsList");
  list.innerHTML = "";

  if (!words.length) {
    list.innerHTML = `
      <div class="hint">
        No saved words yet. Select a word while reading and tap ⭐ Save Word.
      </div>`;
    return;
  }

  words.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "saved-word";

    const info = document.createElement("div");
    info.className = "saved-word-info";

    const title = document.createElement("strong");
    title.textContent = `${index + 1}. ${item.word}`;

    const details = document.createElement("small");
    details.textContent = `${item.english} | ${item.tamil}`;

    info.append(title, details);

    const buttons = document.createElement("div");
    buttons.className = "word-buttons";

    const speak = document.createElement("button");
    speak.className = "small-btn speak-small";
    speak.textContent = "🔊";
    speak.title = "Pronounce";
    speak.onclick = () => speakWord(item.word);

    const del = document.createElement("button");
    del.className = "small-btn delete-small";
    del.textContent = "🗑";
    del.title = "Delete";
    del.onclick = () => deleteWord(item.word);

    buttons.append(speak, del);
    row.append(info, buttons);
    list.appendChild(row);
  });
}

function deleteWord(word) {
  const words = getSavedWords().filter(item => item.word !== word);
  localStorage.setItem("smartread_words", JSON.stringify(words));
  renderVocabulary();
  updateSaveButton();
}

function backHome() {
  $("readerSection").classList.add("hidden");
  $("vocabularySection").classList.add("hidden");
  $("home").classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}