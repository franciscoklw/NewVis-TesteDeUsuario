
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
let worker = null;
let workerPromise = null;

let cameraActive = false;
let readingEnabled = false;
let processing = false;

let lastSpoken = "";
let recognitionTimer = null;
let speechQueue = [];
let isSpeaking = false;

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

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

async function activateCamera() {
    if (cameraActive) return;

    if (!navigator.mediaDevices?.getUserMedia) {
        setStatus(
            "Câmera indisponível",
            "Abre o site em HTTPS ou no localhost e tenta novamente."
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
            "Pronta para reconhecer textos."
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
            "Verifica as permissões do navegador."
        );

        setBadge("ERRO");
    }
}

function stopCamera() {
    readingEnabled = false;
    cameraActive = false;

    clearTimeout(recognitionTimer);
    recognitionTimer = null;

    speechQueue = [];
    isSpeaking = false;

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
        "Ativa a câmera para começar."
    );

    ocrText.textContent = "Aguardando texto...";
    ocrResult.classList.remove("visible");

    lastSpoken = "";
}

async function initializeOCR() {
    if (worker) return worker;
    if (workerPromise) return workerPromise;

    workerPromise = (async () => {
        if (!window.Tesseract) {
            throw new Error(
                "Tesseract.js não foi carregado. Verifica a conexão."
            );
        }

        const newWorker = await Tesseract.createWorker("por+eng");

        await newWorker.setParameters({
            tessedit_pageseg_mode: "6",
            preserve_interword_spaces: "1"
        });

        worker = newWorker;
        return worker;
    })();

    try {
        return await workerPromise;
    } catch (error) {
        workerPromise = null;
        throw error;
    }
}

function prepareImage() {
    const width = camera.videoWidth;
    const height = camera.videoHeight;

    if (!width || !height) {
        throw new Error(
            "A imagem da câmera ainda não está disponível."
        );
    }

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

function speak(text) {
    if (!("speechSynthesis" in window)) {
        setStatus(
            "Áudio indisponível",
            "Este navegador não oferece síntese de voz."
        );
        return;
    }

    const normalized = normalizeText(text);

    if (!normalized || normalized === lastSpoken) {
        return;
    }

    lastSpoken = normalized;

    // Evita enfileirar repetidamente o mesmo texto.
    // Se já houver uma fala em andamento, guarda a nova.
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

    utterance.lang = "pt-BR";
    utterance.rate = 0.95;
    utterance.pitch = 1;

    isSpeaking = true;

    utterance.onstart = () => {
        setStatus("Lendo em voz alta", text);
    };

    utterance.onend = () => {
        isSpeaking = false;

        if (readingEnabled && cameraActive) {
            setStatus(
                "Leitura ativa",
                "Continuando a procurar novos textos."
            );
            processSpeechQueue();
        }
    };

    utterance.onerror = event => {
        console.error("Erro na síntese de voz:", event);

        isSpeaking = false;

        if (readingEnabled && cameraActive) {
            setStatus(
                "Erro no áudio",
                "Verifique o volume e o suporte de voz do navegador."
            );
        }

        processSpeechQueue();
    };

    window.speechSynthesis.speak(utterance);
}

function scheduleRecognition(delay = 800) {
    clearTimeout(recognitionTimer);

    if (!cameraActive || !readingEnabled) return;

    recognitionTimer = setTimeout(recognizeText, delay);
}

async function recognizeText() {
    if (!cameraActive || !readingEnabled || processing) return;

    processing = true;

    try {
        const ocr = await initializeOCR();

        if (!cameraActive || !readingEnabled) return;

        prepareImage();

        const result = await ocr.recognize(canvas);

        if (!cameraActive || !readingEnabled) return;

        const text = result.data.text.trim();
        const confidence = result.data.confidence;

        console.log(
            "Texto reconhecido:",
            text,
            "| Confiança:",
            confidence
        );

        ocrText.textContent = text || "Nenhum texto detectado.";
        ocrResult.classList.add("visible");

        if (text.length > 0) {
            setStatus(
                "Texto detectado",
                `Confiança do OCR: ${Math.round(confidence)}%.`
            );

            speak(text);
        } else {
            setStatus(
                "Procurando texto...",
                "Aponte a câmera para um texto."
            );
        }
    } catch (error) {
        console.error("Erro no reconhecimento:", error);

        setStatus(
            "Erro na leitura",
            error.message || "Não foi possível reconhecer o texto."
        );
    } finally {
        processing = false;

        if (cameraActive && readingEnabled) {
            scheduleRecognition(800);
        }
    }
}

function toggleReading() {
    if (!cameraActive) {
        setStatus(
            "Ativa a câmera primeiro",
            "Depois, habilita a leitura."
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

        // Testa a voz diretamente após o toque do usuário.
        if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();

            const testeVoz = new SpeechSynthesisUtterance(
                "Leitura ativada."
            );

            testeVoz.lang = "pt-BR";
            testeVoz.rate = 0.95;

            window.speechSynthesis.speak(testeVoz);
        }

        setStatus(
            "Iniciando leitura...",
            "Preparando o reconhecimento de texto."
        );

        scheduleRecognition(0);
    } else {
        clearTimeout(recognitionTimer);
        recognitionTimer = null;

        speechQueue = [];
        isSpeaking = false;

        if ("speechSynthesis" in window) {
            window.speechSynthesis.cancel();
        }

        readToggle.textContent = "▤ Ativar leitura";

        setStatus(
            "Câmera ativa",
            "Leitura pausada."
        );
    }
}

startButton.addEventListener("click", activateCamera);
stopButton.addEventListener("click", stopCamera);
readToggle.addEventListener("click", toggleReading);

updateCameraInterface(false);
setStatus("Sistema pronto", "Ativa a câmera para começar.");
setBadge("SISTEMA PRONTO");
