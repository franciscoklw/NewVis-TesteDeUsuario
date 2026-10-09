
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
let lastCandidate = "";
let candidateCount = 0;
let recognitionTimer = null;

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
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" }
            },
            audio: false
        });

        stream = newStream;
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

    window.speechSynthesis?.cancel();

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

    if (ocrText) {
        ocrText.textContent = "Aguardando texto...";
    }

    lastCandidate = "";
    candidateCount = 0;
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
        throw new Error("A imagem da câmera ainda não está disponível.");
    }

    // Redimensiona imagens muito grandes para reduzir o processamento.
    const scale = Math.min(1, 1280 / width);

    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    ctx.drawImage(camera, 0, 0, canvas.width, canvas.height);

    const image = ctx.getImageData(
        0, 0, canvas.width, canvas.height
    );

    const pixels = image.data;

    for (let i = 0; i < pixels.length; i += 4) {
        const gray =
            0.299 * pixels[i] +
            0.587 * pixels[i + 1] +
            0.114 * pixels[i + 2];

        const contrast = Math.max(
            0,
            Math.min(255, (gray - 128) * 1.25 + 128)
        );

        pixels[i] = contrast;
        pixels[i + 1] = contrast;
        pixels[i + 2] = contrast;
    }

    ctx.putImageData(image, 0, 0);
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
            "Leitura sem áudio",
            "Este navegador não oferece síntese de voz."
        );
        return;
    }

    const normalized = normalizeText(text);

    if (normalized.length < 3 || normalized === lastSpoken) {
        return;
    }

    if (window.speechSynthesis.speaking) {
        return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.rate = 0.95;

    utterance.onend = () => {
        if (readingEnabled && cameraActive) {
            setStatus(
                "Leitura ativa",
                "Continuando a procurar novos textos."
            );
        }
    };

    utterance.onerror = event => {
        console.error("Erro na síntese de voz:", event);
    };

    lastSpoken = normalized;
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

        if (text.length >= 3 && confidence >= 25) {
            const normalized = normalizeText(text);

            if (normalized === lastCandidate) {
                candidateCount++;
            } else {
                lastCandidate = normalized;
                candidateCount = 1;
            }

            setStatus(
                "Texto detectado",
                `Confiança do OCR: ${Math.round(confidence)}%.`
            );

            // Exige duas detecções semelhantes para reduzir erros.
            if (candidateCount >= 2) {
                speak(text);
                candidateCount = 0;
            }
        } else {
            lastCandidate = "";
            candidateCount = 0;

            setStatus(
                "Procurando texto...",
                "Aproxima a câmera de um texto bem iluminado."
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
        lastCandidate = "";
        candidateCount = 0;

        readToggle.textContent = "Pausar leitura";

        setStatus(
            "Iniciando leitura...",
            "Preparando o reconhecimento de texto."
        );

        scheduleRecognition(0);
    } else {
        clearTimeout(recognitionTimer);
        recognitionTimer = null;

        window.speechSynthesis.cancel();

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
