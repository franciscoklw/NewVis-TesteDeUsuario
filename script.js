

const camera = document.getElementById("camera");
const viewport = document.getElementById("viewport");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
const readToggle = document.getElementById("readToggle");

const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");
const cameraLabel = document.getElementById("cameraLabel");
const badgeText = document.getElementById("badgeText");
const dot = document.getElementById("dot");
const ocrResult = document.getElementById("ocrResult");
const ocrText = document.getElementById("ocrText");

let stream = null;
let cameraActive = false;
let readingEnabled = false;
let processing = false;
let lastSpoken = "";
let recognitionTimer = null;
let speechQueue = [];
let isSpeaking = false;
let requestId = 0;
let ocrWorkerPromise = null;

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

// Seletor de idioma da voz, criado sem precisar alterar o HTML.
const voiceLanguage = document.createElement("select");
voiceLanguage.id = "voiceLanguage";
voiceLanguage.setAttribute("aria-label", "Idioma da leitura em voz alta");

[
    { value: "auto", label: "Voz: Automática" },
    { value: "pt-BR", label: "Voz: Português" },
    { value: "en-US", label: "Voice: English" }
].forEach(optionData => {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    voiceLanguage.appendChild(option);
});

Object.assign(voiceLanguage.style, {
    margin: "8px",
    padding: "9px",
    maxWidth: "100%",
    borderRadius: "8px",
    border: "1px solid #20c9d2",
    background: "#101b25",
    color: "#ffffff",
    fontSize: "13px"
});

readToggle.insertAdjacentElement("afterend", voiceLanguage);

function setStatus(title, message) {
    statusTitle.textContent = title;
    statusText.textContent = message;
}

function setBadge(text) {
    badgeText.textContent = text;
}

function updateCameraInterface(active) {
    viewport.classList.toggle("on", active);
    document.body.classList.toggle("camera-mode", active);
    dot.classList.toggle("active", active);

    startButton.disabled = active;
    stopButton.disabled = !active;

    cameraLabel.textContent = active
        ? "CAM 01 · ATIVA"
        : "CAM 01 · INATIVA";

    setBadge(active ? "CÂMERA ATIVA" : "SISTEMA PRONTO");
}

// Carrega o reconhecedor uma única vez por sessão.
async function getOcrWorker() {
    if (!window.Tesseract) {
        throw new Error(
            "Tesseract.js não foi carregado. Confira o index.html."
        );
    }

    if (!ocrWorkerPromise) {
        setStatus(
            "Preparando reconhecimento",
            "Baixando os modelos de português e inglês. Aguarde."
        );

        ocrWorkerPromise = window.Tesseract.createWorker(
            ["por", "eng"],
            1,
            {
                logger: message => {
                    if (message.status === "loading language model") {
                        setStatus(
                            "Carregando idiomas",
                            `${message.progress
                                ? Math.round(message.progress * 100) + "%"
                                : "Aguarde"}`
                        );
                    }
                }
            }
        ).catch(error => {
            ocrWorkerPromise = null;
            throw error;
        });
    }

    return ocrWorkerPromise;
}

async function activateCamera() {
    if (cameraActive) return;

    if (!navigator.mediaDevices?.getUserMedia) {
        setStatus(
            "Câmera indisponível",
            "Abra o site em HTTPS ou no localhost."
        );
        setBadge("ERRO");
        return;
    }

    startButton.disabled = true;
    setStatus("Ativando câmera...", "Aguardando permissão.");
    setBadge("CONECTANDO");

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" }
            },
            audio: false
        });

        camera.srcObject = stream;
        await camera.play();

        cameraActive = true;
        updateCameraInterface(true);

        setStatus(
            "Câmera ativada",
            "Pronta para reconhecer textos em português e inglês."
        );
    } catch (error) {
        console.error("Erro ao ativar a câmera:", error);

        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }

        stream = null;
        camera.srcObject = null;
        cameraActive = false;

        updateCameraInterface(false);

        setStatus(
            "Não foi possível ativar a câmera",
            "Verifique as permissões do navegador."
        );

        setBadge("ERRO");
    }
}

function stopCamera() {
    cameraActive = false;
    readingEnabled = false;
    requestId++;

    clearTimeout(recognitionTimer);
    recognitionTimer = null;

    speechQueue = [];
    isSpeaking = false;
    lastSpoken = "";

    if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
    }

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }

    camera.pause();
    camera.srcObject = null;

    readToggle.textContent = "▤ Ativar leitura";
    readToggle.setAttribute("aria-pressed", "false");
    readToggle.classList.remove("reading");

    updateCameraInterface(false);

    setStatus(
        "Câmera desligada",
        "Ative a câmera para começar."
    );

    ocrText.textContent = "Aguardando texto...";
    ocrResult.classList.remove("visible");
}

function prepareImage() {
    const width = camera.videoWidth;
    const height = camera.videoHeight;

    if (!width || !height) {
        throw new Error("A imagem da câmera ainda não está disponível.");
    }

    // Reduz a imagem para equilibrar velocidade e legibilidade.
    const scale = Math.min(1, 1280 / width);

    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);
}

function normalizeText(text) {
    return text
        .toLocaleLowerCase("pt-BR")
        .replace(/\s+/g, " ")
        .trim();
}

// Detecção aproximada para escolher a voz.
// A escolha manual é mais confiável para frases curtas.
function detectLanguage(text) {
    const portugueseWords = new Set([
        "de", "do", "da", "dos", "das", "que", "não", "sim",
        "para", "com", "uma", "um", "por", "é", "são", "você",
        "texto", "saída", "entrada", "atenção", "obrigado"
    ]);

    const englishWords = new Set([
        "the", "and", "this", "that", "you", "are", "is", "of",
        "to", "for", "with", "not", "hello", "welcome", "exit",
        "enter", "attention", "thank", "please"
    ]);

    const words = normalizeText(text)
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .split(/\s+/);

    let pt = 0;
    let en = 0;

    for (const word of words) {
        if (portugueseWords.has(word)) pt++;
        if (englishWords.has(word)) en++;
    }

    return en > pt ? "en-US" : "pt-BR";
}

function speak(text) {
    if (!("speechSynthesis" in window)) {
        setStatus(
            "Áudio indisponível",
            "Este navegador não oferece síntese de voz."
        );
        return;
    }

    const normalized = normalizeText(text);

    if (!normalized || normalized === lastSpoken) return;

    lastSpoken = normalized;

    speechQueue = speechQueue.filter(
        item => normalizeText(item) !== normalized
    );

    speechQueue.push(text);
    processSpeechQueue();
}

function processSpeechQueue() {
    if (!readingEnabled || !cameraActive) return;
    if (isSpeaking || speechQueue.length === 0) return;
    if (!("speechSynthesis" in window)) return;

    const text = speechQueue.shift();
    const utterance = new SpeechSynthesisUtterance(text);

    const selectedLanguage = voiceLanguage.value;

    utterance.lang = selectedLanguage === "auto"
        ? detectLanguage(text)
        : selectedLanguage;

    utterance.rate = 0.95;
    utterance.pitch = 1;

    // Tenta escolher uma voz instalada no navegador.
    const voices = window.speechSynthesis.getVoices();
    const matchingVoice = voices.find(voice =>
        voice.lang.toLowerCase().startsWith(
            utterance.lang.toLowerCase().split("-")[0]
        )
    );

    if (matchingVoice) {
        utterance.voice = matchingVoice;
    }

    isSpeaking = true;

    utterance.onstart = () => {
        setStatus(
            `Lendo em ${utterance.lang === "en-US" ? "inglês" : "português"}`,
            text
        );
    };

    utterance.onend = () => {
        isSpeaking = false;

        if (readingEnabled && cameraActive) {
            setStatus(
                "Leitura ativa",
                "Procurando novos textos."
            );
            processSpeechQueue();
        }
    };

    utterance.onerror = error => {
        console.error("Erro na síntese de voz:", error);
        isSpeaking = false;

        if (readingEnabled && cameraActive) {
            setStatus(
                "Erro no áudio",
                "Verifique o volume e as vozes disponíveis no navegador."
            );
        }

        processSpeechQueue();
    };

    window.speechSynthesis.speak(utterance);
}

function scheduleRecognition(delay = 3000) {
    clearTimeout(recognitionTimer);

    if (!cameraActive || !readingEnabled) return;

    recognitionTimer = setTimeout(recognizeText, delay);
}

async function recognizeText() {
    if (!cameraActive || !readingEnabled || processing) return;

    processing = true;
    const currentRequest = requestId;

    try {
        prepareImage();

        const worker = await getOcrWorker();

        if (
            !cameraActive ||
            !readingEnabled ||
            currentRequest !== requestId
        ) {
            return;
        }

        setStatus(
            "Reconhecendo texto...",
            "Processando a imagem no próprio navegador."
        );

        const result = await worker.recognize(canvas);

        if (
            !cameraActive ||
            !readingEnabled ||
            currentRequest !== requestId
        ) {
            return;
        }

        const text = (result.data.text || "").trim();

        console.log("Texto reconhecido:", text);

        ocrText.textContent = text || "Nenhum texto detectado.";
        ocrResult.classList.add("visible");

        if (text) {
            setStatus(
                "Texto detectado",
                "Reconhecimento local concluído."
            );
            speak(text);
        } else {
            setStatus(
                "Procurando texto...",
                "Aponte a câmera para um texto bem iluminado."
            );
        }
    } catch (error) {
        console.error("Erro no reconhecimento:", error);

        if (
            !cameraActive ||
            !readingEnabled ||
            currentRequest !== requestId
        ) {
            return;
        }

        setStatus(
            "Erro na leitura",
            error.message || "Falha ao reconhecer o texto."
        );
    } finally {
        processing = false;

        if (cameraActive && readingEnabled) {
            scheduleRecognition(3000);
        }
    }
}

function toggleReading() {
    if (!cameraActive) {
        setStatus(
            "Ative a câmera primeiro",
            "Depois, habilite a leitura."
        );
        return;
    }

    readingEnabled = !readingEnabled;

    readToggle.setAttribute(
        "aria-pressed",
        String(readingEnabled)
    );

    readToggle.classList.toggle("reading", readingEnabled);

    if (readingEnabled) {
        lastSpoken = "";
        speechQueue = [];
        isSpeaking = false;

        readToggle.textContent = "Pausar leitura";

        if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();

            const testeVoz = new SpeechSynthesisUtterance(
                "Leitura ativada."
            );

            testeVoz.lang = voiceLanguage.value === "en-US"
                ? "en-US"
                : "pt-BR";

            window.speechSynthesis.speak(testeVoz);
        }

        setStatus(
            "Iniciando leitura...",
            "Preparando os modelos de português e inglês."
        );

        scheduleRecognition(0);
    } else {
        requestId++;

        clearTimeout(recognitionTimer);
        recognitionTimer = null;

        speechQueue = [];
        isSpeaking = false;

        if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();
        }

        readToggle.textContent = "▤ Ativar leitura";

        setStatus("Câmera ativa", "Leitura pausada.");
    }
}

startButton.addEventListener("click", activateCamera);
stopButton.addEventListener("click", stopCamera);
readToggle.addEventListener("click", toggleReading);

updateCameraInterface(false);
setStatus("Sistema pronto", "Ative a câmera para começar.");
setBadge("SISTEMA PRONTO");

