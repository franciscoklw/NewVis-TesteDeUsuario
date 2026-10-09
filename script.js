
const camera = document.getElementById("camera");
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
let cameraActive = false;
let readingEnabled = false;
let processing = false;
let lastSpoken = "";
let lastCandidate = "";
let candidateCount = 0;

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

function setStatus(title, message) {
    if (statusTitle) statusTitle.textContent = title;
    if (statusText) statusText.textContent = message;
}

function setBadge(text) {
    if (badgeText) badgeText.textContent = text;
}

async function activateCamera() {
    try {
        if (cameraActive) return;

        setStatus("Ativando câmera...", "Solicitando acesso à câmera.");
        setBadge("CONECTANDO");

        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" }
            },
            audio: false
        });

        camera.srcObject = stream;
        await camera.play();

        cameraActive = true;

        if (cameraLabel) cameraLabel.textContent = "Câmera ativa";

        setStatus("Câmera ativada", "Pronta para reconhecer textos.");
        setBadge("CÂMERA ATIVA");

        if (dot) dot.classList.add("active");

    } catch (error) {
        console.error("Erro ao ativar a câmera:", error);

        setStatus(
            "Não foi possível ativar a câmera",
            "Verifique a permissão da câmera e tente novamente."
        );

        setBadge("ERRO");
    }
}

function stopCamera() {
    readingEnabled = false;
    cameraActive = false;

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }

    if (camera) {
        camera.pause();
        camera.srcObject = null;
    }

    if (dot) dot.classList.remove("active");
    if (cameraLabel) cameraLabel.textContent = "Câmera desligada";

    setStatus("Câmera desligada", "Ative a câmera para começar.");
    setBadge("DESLIGADA");
}

async function initializeOCR() {
    if (worker) return worker;

    if (!window.Tesseract) {
        throw new Error("Biblioteca Tesseract.js não carregada.");
    }

    worker = await Tesseract.createWorker("por+eng");

    await worker.setParameters({
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1"
    });

    return worker;
}

function prepareImage() {
    const width = camera.videoWidth;
    const height = camera.videoHeight;

    if (!width || !height) {
        throw new Error("A imagem da câmera ainda não está disponível.");
    }

    canvas.width = width;
    canvas.height = height;

    ctx.drawImage(camera, 0, 0, width, height);

    const image = ctx.getImageData(0, 0, width, height);
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

function speak(text) {
    if (!("speechSynthesis" in window)) return;

    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();

    if (normalized.length < 3 || normalized === lastSpoken) return;
    if (window.speechSynthesis.speaking) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.rate = 0.95;

    lastSpoken = normalized;
    window.speechSynthesis.speak(utterance);
}

async function recognizeText() {
    if (!cameraActive || !readingEnabled || processing) return;

    processing = true;

    try {
        const ocr = await initializeOCR();

        if (!cameraActive || !readingEnabled) return;

        prepareImage();

        const result = await ocr.recognize(canvas);
        const text = result.data.text.trim();
        const confidence = result.data.confidence;

        console.log("Texto:", text, "| Confiança:", confidence);

        if (ocrText) {
            ocrText.textContent = text || "Nenhum texto detectado.";
        }

        if (ocrResult) {
            ocrResult.hidden = false;
        }

        if (text.length >= 3 && confidence >= 25) {
            const normalized = text
                .toLowerCase()
                .replace(/\s+/g, " ")
                .trim();

            if (normalized === lastCandidate) {
                candidateCount++;
            } else {
                lastCandidate = normalized;
                candidateCount = 1;
            }

            setStatus(
                "Texto detectado",
                `Confiança do OCR: ${Math.round(confidence)}%`
            );

            if (candidateCount >= 2) {
                speak(text);
                candidateCount = 0;
            }
        } else {
            lastCandidate = "";
            candidateCount = 0;
            setStatus(
                "Procurando texto...",
                "Aproxime a câmera de um texto bem iluminado."
            );
        }

    } catch (error) {
        console.error("Erro no reconhecimento:", error);
        setStatus("Erro na leitura", "Verifique o console para ver os detalhes.");
    } finally {
        processing = false;

        if (cameraActive && readingEnabled) {
            setTimeout(recognizeText, 700);
        }
    }
}

startButton.addEventListener("click", activateCamera);

stopButton.addEventListener("click", stopCamera);

readToggle.addEventListener("change", async () => {
    readingEnabled = readToggle.checked;

    if (readingEnabled) {
        if (!cameraActive) {
            readingEnabled = false;
            readToggle.checked = false;

            setStatus(
                "Ative a câmera primeiro",
                "Depois, habilite a leitura."
            );
            return;
        }

        lastSpoken = "";
        lastCandidate = "";
        candidateCount = 0;

        setStatus("Iniciando leitura...", "Procurando texto na imagem.");
        recognizeText();

    } else {
        window.speechSynthesis.cancel();

        setStatus(
            cameraActive ? "Câmera ativa" : "Câmera desligada",
            "Leitura pausada."
        );
    }
});

if (ocrResult) {
    ocrResult.hidden = false;
}

setStatus("Sistema pronto", "Ative a câmera para começar.");
setBadge("AGUARDANDO");
