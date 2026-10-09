
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

// API Python com EasyOCR.
// Endereço válido para testes no mesmo computador.
const API_URL = "http://127.0.0.1:8000/reconhecer";

let stream = null;
let cameraActive = false;
let readingEnabled = false;
let processing = false;

let lastSpoken = "";
let recognitionTimer = null;
let speechQueue = [];
let isSpeaking = false;
let requestId = 0;

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
        "Ativa a câmera para começar."
    );

    ocrText.textContent = "Aguardando texto...";
    ocrResult.classList.remove("visible");
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

function canvasToBlob() {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            blob => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(
                        new Error("Não foi possível preparar a imagem.")
                    );
                }
            },
            "image/jpeg",
            0.90
        );
    });
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

    utterance.onerror = error => {
        console.error("Erro na síntese de voz:", error);

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

function scheduleRecognition(delay = 1500) {
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

        const imagem = await canvasToBlob();

        if (
            !cameraActive ||
            !readingEnabled ||
            currentRequest !== requestId
        ) {
            return;
        }

        const formData = new FormData();

        formData.append("file", imagem, "captura.jpg");

        setStatus(
            "Reconhecendo texto...",
            "Enviando a imagem para o EasyOCR."
        );

        const response = await fetch(API_URL, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            let detalhe = `Erro HTTP ${response.status}`;

            try {
                const erro = await response.json();
                if (erro.detail) detalhe = erro.detail;
            } catch {
                // Mantém a mensagem HTTP caso não haja JSON.
            }

            throw new Error(detalhe);
        }

        const resultado = await response.json();

        if (
            !cameraActive ||
            !readingEnabled ||
            currentRequest !== requestId
        ) {
            return;
        }

        const text = (resultado.texto || "").trim();
        const trechos = resultado.trechos || [];

        console.log(
            "Texto reconhecido:",
            text,
            "| Trechos:",
            trechos.length,
            "| Quantidade:",
            resultado.quantidade
        );

        ocrText.textContent = text || "Nenhum texto detectado.";
        ocrResult.classList.add("visible");

        if (text) {
            setStatus(
                "Texto detectado",
                `${trechos.length} trechos reconhecidos pelo EasyOCR.`
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

        if (
            !cameraActive ||
            !readingEnabled ||
            currentRequest !== requestId
        ) {
            return;
        }

        const mensagem = error.message || "Falha no reconhecimento.";

        if (
            error instanceof TypeError &&
            /fetch/i.test(mensagem)
        ) {
            setStatus(
                "API indisponível",
                "Confirme se o servidor Python está rodando e se o navegador permite a conexão."
            );
        } else {
            setStatus("Erro na leitura", mensagem);
        }
    } finally {
        processing = false;

        if (cameraActive && readingEnabled) {
            scheduleRecognition(1500);
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
            "Preparando o reconhecimento com EasyOCR."
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
