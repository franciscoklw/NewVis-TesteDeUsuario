
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

let stream = null;
let ocrWorker = null;
let workerPromise = null;
let ocrBusy = false;
let readingEnabled = false;
let readTimer = null;
let readingSession = 0;

let candidateText = "";
let candidateCount = 0;
let lastSpokenText = "";

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

function prepareImage() {
    const width = camera.videoWidth;
    const height = camera.videoHeight;

    if (!width || !height) {
        throw new Error("A câmera ainda não disponibilizou uma imagem.");
    }

    const scale = Math.min(1.5, 1600 / width);
    const canvas = document.createElement("canvas");

    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d", {
        willReadFrequently: true
    });

    context.drawImage(camera, 0, 0, canvas.width, canvas.height);

    const image = context.getImageData(
        0, 0, canvas.width, canvas.height
    );

    const pixels = image.data;

    for (let i = 0; i < pixels.length; i += 4) {
        const gray =
            0.299 * pixels[i] +
            0.587 * pixels[i + 1] +
            0.114 * pixels[i + 2];

        const adjusted = Math.max(
            0,
            Math.min(255, (gray - 128) * 1.15 + 128)
        );

        pixels[i] = adjusted;
        pixels[i + 1] = adjusted;
        pixels[i + 2] = adjusted;
    }

    context.putImageData(image, 0, 0);
    return canvas;
}

async function initializeOCR() {
    if (ocrWorker) return ocrWorker;

    if (!window.Tesseract) {
        throw new Error("Tesseract.js não foi carregado.");
    }

    // Impede inicializações simultâneas do mesmo worker.
    if (!workerPromise) {
        statusTitle.textContent = "Preparando leitura";
        statusText.textContent =
            "Carregando os modelos de reconhecimento...";

        workerPromise = (async () => {
            const worker = await window.Tesseract.createWorker("por+eng");

            await worker.setParameters({
                tessedit_pageseg_mode: "6",
                preserve_interword_spaces: "1"
            });

            ocrWorker = worker;
            return worker;
        })().catch(error => {
            workerPromise = null;
            throw error;
        });
    }

    return workerPromise;
}

function speakText(text) {
    if (!("speechSynthesis" in window)) {
        statusText.textContent =
            "A leitura por voz não é suportada neste navegador.";
        return;
    }

    const cleanText = text.trim();
    const normalized = normalizeText(cleanText);

    if (normalized.length < 4) return;
    if (normalized === lastSpokenText) return;

    // Não interrompe uma fala que já está em andamento.
    if (window.speechSynthesis.speaking) return;

    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = detectLanguage(cleanText);
    utterance.rate = 0.9;
    utterance.pitch = 1;

    utterance.onstart = () => {
        if (readingEnabled) {
            statusTitle.textContent = "Lendo texto";
            statusText.textContent = "Reproduzindo o texto reconhecido.";
        }
    };

    utterance.onend = () => {
        if (readingEnabled) {
            statusTitle.textContent = "Leitura ativa";
            statusText.textContent = "Procurando novo texto...";
        }
    };

    utterance.onerror = event => {
        console.error("Erro na síntese de voz:", event.error);

        if (readingEnabled) {
            statusText.textContent =
                "A voz falhou. Verifique o áudio e o navegador.";
        }
    };

    // Registra o texto somente quando ele for enviado à síntese.
    lastSpokenText = normalized;
    window.speechSynthesis.speak(utterance);
}

function scheduleRecognition(session, delay = 1500) {
    clearTimeout(readTimer);

    if (!readingEnabled || session !== readingSession) return;

    readTimer = setTimeout(() => {
        recognizeFrame(session);
    }, delay);
}

async function recognizeFrame(session) {
    if (!readingEnabled || session !== readingSession) return;

    // Se a análise anterior ainda estiver ocupada, tenta novamente.
    if (ocrBusy) {
        scheduleRecognition(session, 500);
        return;
    }

    if (!camera.videoWidth || camera.readyState < 2) {
        statusTitle.textContent = "Aguardando câmera";
        statusText.textContent = "Esperando a próxima imagem...";
        scheduleRecognition(session, 700);
        return;
    }

    ocrBusy = true;

    try {
        const worker = await initializeOCR();

        if (!readingEnabled || session !== readingSession) return;

        const canvas = prepareImage();
        const result = await worker.recognize(canvas);

        if (!readingEnabled || session !== readingSession) return;

        const text = result.data.text.trim();
        const confidence = Number(result.data.confidence) || 0;
        const normalized = normalizeText(text);

        if (normalized.length < 2) {
            candidateText = "";
            candidateCount = 0;

            statusTitle.textContent = "Procurando texto";
            statusText.textContent =
                "Aproxime a câmera de um texto bem iluminado.";

            scheduleRecognition(session, 1000);
            return;
        }

        // Exibe o texto mesmo quando a confiança for baixa.
        ocrResult.classList.add("visible");
        ocrText.textContent =
            `${text}\n\nConfiança estimada do OCR: ${Math.round(confidence)}%`;

        // Limite reduzido para não descartar tantas leituras.
        // O valor é apenas um filtro experimental, não uma garantia.
        if (confidence < 25) {
            candidateText = "";
            candidateCount = 0;

            statusTitle.textContent = "Reconhecimento incerto";
            statusText.textContent =
                "Texto encontrado, mas a leitura pode conter erros.";

            scheduleRecognition(session, 1200);
            return;
        }

        if (normalized === candidateText) {
            candidateCount++;
        } else {
            candidateText = normalized;
            candidateCount = 1;
        }

        statusTitle.textContent = "Texto identificado";
        statusText.textContent =
            `Confiança estimada: ${Math.round(confidence)}%.`;

        // Duas capturas semelhantes antes de falar.
        if (candidateCount >= 2) {
            speakText(text);
        }

    } catch (error) {
        console.error("Erro no OCR:", error);

        if (readingEnabled && session === readingSession) {
            statusTitle.textContent = "Falha no reconhecimento";
            statusText.textContent =
                `${error.message || "Erro desconhecido"}. Verifique a conexão e tente novamente.`;
        }
    } finally {
        ocrBusy = false;

        // Agenda a próxima análise mesmo após um retorno antecipado.
        scheduleRecognition(session, 1500);
    }
}

start.addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
        statusTitle.textContent = "Câmera indisponível";
        statusText.textContent =
            "Acesse o site por HTTPS ou localhost.";
        return;
    }

    start.disabled = true;

    try {
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false
        });

        stream = newStream;
        camera.srcObject = stream;
        await camera.play();

        viewport.classList.add("on");
        document.body.classList.add("camera-mode");

        statusTitle.textContent = "Câmera ativa";
        statusText.textContent = "Ative a leitura para reconhecer textos.";

        cameraLabel.textContent = "CAM 01 · ATIVA";
        badgeText.textContent = "CÂMERA ATIVA";
        dot.classList.add("active");

        start.textContent = "Câmera ativada";
        stop.disabled = false;

    } catch (error) {
        console.error("Erro ao ativar câmera:", error);

        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }

        stream = null;
        camera.srcObject = null;

        const messages = {
            NotAllowedError: "Permita o acesso à câmera nas configurações do navegador.",
            NotFoundError: "Nenhuma câmera foi encontrada.",
            NotReadableError: "A câmera pode estar sendo usada por outro aplicativo."
        };

        statusTitle.textContent = "Não foi possível iniciar";
        statusText.textContent =
            messages[error.name] || "Verifique as permissões da câmera.";

        start.disabled = false;
        start.textContent = "◎  Ativar câmera";
    }
});

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
        statusText.textContent = "A câmera continua ativa.";
        return;
    }

    if (!stream || !camera.videoWidth) {
        statusTitle.textContent = "Ative a câmera primeiro";
        statusText.textContent = "Ligue a câmera antes de iniciar a leitura.";
        return;
    }

    readingEnabled = true;
    readingSession++;

    const session = readingSession;

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

    recognizeFrame(session);
});

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

window.addEventListener("pagehide", () => {
    readingEnabled = false;
    readingSession++;

    clearTimeout(readTimer);
    window.speechSynthesis?.cancel();

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
});
