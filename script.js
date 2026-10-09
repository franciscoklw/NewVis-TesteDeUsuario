
const camera = document.getElementById("camera");
const viewport = document.getElementById("viewport");

const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");
const cameraLabel = document.getElementById("cameraLabel");

const badgeText = document.getElementById("badgeText");
const dot = document.getElementById("dot");

const start = document.getElementById("start");
const stop = document.getElementById("stop");
const readToggle = document.getElementById("readToggle");

const ocrResult = document.getElementById("ocrResult");
const ocrText = document.getElementById("ocrText");

// Estado da câmera e do reconhecimento
let stream = null;
let ocrWorker = null;
let ocrBusy = false;
let readingEnabled = false;
let readTimer = null;
let readingSession = 0;

// Controle para evitar leituras repetidas ou instáveis
let candidateText = "";
let candidateCount = 0;
let lastSpokenText = "";

// --------------------------------------------------
// FUNÇÕES AUXILIARES
// --------------------------------------------------

function normalizeText(text) {
  return text
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function detectLanguage(text) {
  const lower = ` ${text.toLocaleLowerCase("pt-BR")} `;

  const englishWords =
    /\b(the|this|that|with|you|your|is|are|welcome|please|hello|world)\b/g;

  const portugueseWords =
    /\b(de|que|com|para|voce|voces|uma|nao|ola|obrigado|bem-vindo|bem-vinda)\b/g;

  const enCount = (lower.match(englishWords) || []).length;
  const ptCount = (lower.match(portugueseWords) || []).length;

  return enCount > ptCount ? "en-US" : "pt-BR";
}

// --------------------------------------------------
// MELHORIA DA IMAGEM PARA O OCR
// --------------------------------------------------

function prepareImage() {
  const originalWidth = camera.videoWidth;
  const originalHeight = camera.videoHeight;

  // Amplia imagens pequenas e limita imagens muito grandes.
  const scale = Math.min(2, 1800 / originalWidth);

  const canvas = document.createElement("canvas");

  canvas.width = Math.max(1, Math.round(originalWidth * scale));
  canvas.height = Math.max(1, Math.round(originalHeight * scale));

  const context = canvas.getContext("2d", {
    willReadFrequently: true
  });

  context.drawImage(
    camera,
    0,
    0,
    canvas.width,
    canvas.height
  );

  // Converte para tons de cinza e aumenta moderadamente o contraste.
  const image = context.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );

  const pixels = image.data;

  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i];
    const green = pixels[i + 1];
    const blue = pixels[i + 2];

    const gray =
      0.299 * red +
      0.587 * green +
      0.114 * blue;

    const contrast = Math.max(
      0,
      Math.min(255, (gray - 128) * 1.25 + 128)
    );

    pixels[i] = contrast;
    pixels[i + 1] = contrast;
    pixels[i + 2] = contrast;
  }

  context.putImageData(image, 0, 0);

  return canvas;
}

// --------------------------------------------------
// PREPARAÇÃO DO TESSERACT
// --------------------------------------------------

async function initializeOCR() {
  if (ocrWorker) return;

  if (!window.Tesseract) {
    throw new Error("A biblioteca Tesseract.js não foi carregada.");
  }

  statusTitle.textContent = "Preparando leitura";
  statusText.textContent =
    "Baixando os modelos de reconhecimento de texto...";

  // Português e inglês.
  ocrWorker = await Tesseract.createWorker("por+eng");

  // Assume que a imagem contém um bloco de texto.
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1"
  });
}

// --------------------------------------------------
// LEITURA EM VOZ ALTA
// --------------------------------------------------

function speakText(text) {
  if (!("speechSynthesis" in window)) {
    statusText.textContent =
      "Este navegador não oferece leitura por voz.";
    return;
  }

  const cleanText = text.trim();
  const normalized = normalizeText(cleanText);

  if (normalized.length < 4) return;

  // Não repete um texto já falado.
  if (normalized === lastSpokenText) return;

  // Evita interromper uma fala que ainda está acontecendo.
  if (window.speechSynthesis.speaking) return;

  const utterance = new SpeechSynthesisUtterance(cleanText);

  utterance.lang = detectLanguage(cleanText);
  utterance.rate = 0.88;
  utterance.pitch = 1;

  utterance.onerror = () => {
    if (readingEnabled) {
      statusText.textContent =
        "Não foi possível reproduzir a leitura por voz.";
    }
  };

  lastSpokenText = normalized;
  window.speechSynthesis.speak(utterance);
}

// --------------------------------------------------
// RECONHECIMENTO DO TEXTO
// --------------------------------------------------

async function recognizeFrame(session) {
  if (
    !readingEnabled ||
    session !== readingSession ||
    ocrBusy
  ) {
    return;
  }

  if (!camera.videoWidth || !camera.videoHeight) {
    readTimer = setTimeout(
      () => recognizeFrame(session),
      1000
    );
    return;
  }

  ocrBusy = true;

  try {
    await initializeOCR();

    // Uma sessão antiga não pode atualizar a interface.
    if (!readingEnabled || session !== readingSession) {
      return;
    }

    const canvas = prepareImage();
    const result = await ocrWorker.recognize(canvas);

    if (!readingEnabled || session !== readingSession) {
      return;
    }

    const text = result.data.text.trim();
    const confidence = Number(result.data.confidence) || 0;
    const normalized = normalizeText(text);

    // Pouco texto geralmente indica ausência de conteúdo legível.
    if (normalized.length < 4) {
      candidateText = "";
      candidateCount = 0;

      statusTitle.textContent = "Procurando texto";
      statusText.textContent =
        "Aproxime a câmera, melhore a iluminação e mantenha o texto estável.";

      return;
    }

    // Mostra o resultado do OCR, mesmo quando a confiança é baixa,
    // para facilitar a avaliação do protótipo.
    ocrResult.classList.add("visible");
    ocrText.textContent = text;

    // Não fala resultados com confiança muito baixa.
    if (confidence < 45) {
      candidateText = "";
      candidateCount = 0;

      statusTitle.textContent = "Reconhecimento incerto";
      statusText.textContent =
        `Confiança: ${Math.round(confidence)}%. Tente aproximar a câmera ou melhorar a iluminação.`;

      return;
    }

    // Exige que o mesmo conteúdo apareça em capturas consecutivas.
    if (normalized === candidateText) {
      candidateCount++;
    } else {
      candidateText = normalized;
      candidateCount = 1;
    }

    statusTitle.textContent = "Texto identificado";
    statusText.textContent =
      `Confiança do OCR: ${Math.round(confidence)}%. Confirmando resultado...`;

    if (candidateCount >= 2) {
      statusText.textContent =
        `Texto confirmado pelo reconhecimento (${Math.round(confidence)}%).`;

      speakText(text);
    }

  } catch (error) {
    console.error("Erro no reconhecimento de texto:", error);

    if (session === readingSession && readingEnabled) {
      statusTitle.textContent = "Falha na leitura";
      statusText.textContent =
        "Verifique a conexão com a internet e tente novamente.";
    }

  } finally {
    ocrBusy = false;

    // Aguarda antes de analisar a próxima imagem.
    if (readingEnabled && session === readingSession) {
      readTimer = setTimeout(
        () => recognizeFrame(session),
        2500
      );
    }
  }
}

// --------------------------------------------------
// ATIVAR A CÂMERA
// --------------------------------------------------

start.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    statusTitle.textContent = "Câmera indisponível";
    statusText.textContent =
      "Abra o site por HTTPS ou localhost e tente novamente.";
    return;
  }

  start.disabled = true;

  statusTitle.textContent = "Solicitando acesso";
  statusText.textContent =
    "Autorize o acesso à câmera no navegador.";

  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" }
      },
      audio: false
    });

    // Se a solicitação for concluída depois de a página mudar,
    // não mantém uma transmissão desnecessária.
    stream = newStream;
    camera.srcObject = stream;

    await camera.play();

    viewport.classList.add("on");
    document.body.classList.add("camera-mode");

    statusTitle.textContent = "Visor inteligente ativo";
    statusText.textContent =
      "Ative a leitura para reconhecer textos.";

    cameraLabel.textContent = "CAM 01 · ATIVA";
    badgeText.textContent = "CÂMERA ATIVA";
    dot.classList.add("active");

    start.textContent = "Câmera ativada";
    stop.disabled = false;

  } catch (error) {
    console.error("Erro ao ativar a câmera:", error);

    const messages = {
      NotAllowedError:
        "Permissão negada. Autorize a câmera nas configurações do navegador.",
      NotFoundError:
        "Nenhuma câmera compatível foi encontrada.",
      NotReadableError:
        "A câmera pode estar sendo usada por outro aplicativo.",
      OverconstrainedError:
        "Não foi possível selecionar uma câmera compatível."
    };

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }

    stream = null;
    camera.srcObject = null;

    viewport.classList.remove("on");
    document.body.classList.remove("camera-mode");

    statusTitle.textContent = "Não foi possível iniciar";
    statusText.textContent =
      messages[error.name] ||
      "Verifique as permissões e tente novamente.";

    cameraLabel.textContent = "CAM 01 · INATIVA";
    badgeText.textContent = "SISTEMA PRONTO";
    dot.classList.remove("active");

    start.disabled = false;
    start.textContent = "◎  Ativar câmera";
    stop.disabled = true;
  }
});

// --------------------------------------------------
// ATIVAR OU DESATIVAR A LEITURA
// --------------------------------------------------

readToggle.addEventListener("click", async () => {
  if (readingEnabled) {
    readingEnabled = false;
    readingSession++;

    clearTimeout(readTimer);
    window.speechSynthesis?.cancel();

    candidateText = "";
    candidateCount = 0;

    readToggle.textContent = "▤ Ativar leitura";
    readToggle.classList.remove("reading");
    readToggle.setAttribute("aria-pressed", "false");

    statusTitle.textContent = "Leitura desativada";
    statusText.textContent =
      "A câmera continua ativa, mas não está lendo textos.";

    return;
  }

  if (!stream || !camera.videoWidth) {
    statusTitle.textContent = "Ative a câmera primeiro";
    statusText.textContent =
      "Ligue a câmera antes de iniciar a leitura.";
    return;
  }

  if (!window.Tesseract) {
    statusTitle.textContent = "Biblioteca indisponível";
    statusText.textContent =
      "Verifique a internet e recarregue a página.";
    return;
  }

  readingEnabled = true;
  readingSession++;

  const currentSession = readingSession;

  candidateText = "";
  candidateCount = 0;
  lastSpokenText = "";

  clearTimeout(readTimer);
  window.speechSynthesis?.cancel();

  readToggle.textContent = "■ Desativar leitura";
  readToggle.classList.add("reading");
  readToggle.setAttribute("aria-pressed", "true");

  ocrResult.classList.add("visible");
  ocrText.textContent = "Preparando reconhecimento...";

  recognizeFrame(currentSession);
});

// --------------------------------------------------
// DESATIVAR A CÂMERA
// --------------------------------------------------

stop.addEventListener("click", () => {
  readingEnabled = false;
  readingSession++;

  clearTimeout(readTimer);
  window.speechSynthesis?.cancel();

  candidateText = "";
  candidateCount = 0;
  lastSpokenText = "";

  readToggle.textContent = "▤ Ativar leitura";
  readToggle.classList.remove("reading");
  readToggle.setAttribute("aria-pressed", "false");

  ocrResult.classList.remove("visible");
  ocrText.textContent = "Aguardando texto...";

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  stream = null;
  camera.srcObject = null;

  viewport.classList.remove("on");
  document.body.classList.remove("camera-mode");

  statusTitle.textContent = "Sistema em espera";
  statusText.textContent = "A câmera está desligada.";

  cameraLabel.textContent = "CAM 01 · INATIVA";
  badgeText.textContent = "SISTEMA PRONTO";
  dot.classList.remove("active");

  start.disabled = false;
  start.textContent = "◎  Ativar câmera";
  stop.disabled = true;
});

// --------------------------------------------------
// ENCERRAR A CÂMERA AO SAIR DA PÁGINA
// --------------------------------------------------

window.addEventListener("pagehide", () => {
  readingEnabled = false;
  readingSession++;

  clearTimeout(readTimer);
  window.speechSynthesis?.cancel();

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  stream = null;
});
