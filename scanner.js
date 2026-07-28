(function () {
    'use strict';

    class Html5Qrcode {
        constructor(elementId) {
            this.element = document.getElementById(elementId);
            this.stream = null;
            this.timer = null;
            this.detecting = false;
        }

        async start(camera, config, onSuccess, onFailure) {
            if (!('BarcodeDetector' in window)) {
                throw new Error('QR scanning is not supported by this browser');
            }

            const supportedFormats = await BarcodeDetector.getSupportedFormats();
            if (!supportedFormats.includes('qr_code')) {
                throw new Error('QR scanning is not supported by this browser');
            }

            const detector = new BarcodeDetector({ formats: ['qr_code'] });
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: camera,
                audio: false
            });

            const video = document.createElement('video');
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.srcObject = this.stream;
            this.element.replaceChildren(video);
            await video.play();

            const interval = Math.max(100, Math.round(1000 / (config.fps || 10)));
            this.timer = window.setInterval(async () => {
                if (this.detecting || video.readyState < 2) return;
                this.detecting = true;
                try {
                    const results = await detector.detect(video);
                    if (results.length > 0) onSuccess(results[0].rawValue);
                    else onFailure('No QR code detected');
                } catch (error) {
                    onFailure('QR detection failed');
                } finally {
                    this.detecting = false;
                }
            }, interval);
        }

        stop() {
            if (this.timer !== null) window.clearInterval(this.timer);
            if (this.stream) this.stream.getTracks().forEach(track => track.stop());
            this.timer = null;
            this.stream = null;
            return Promise.resolve();
        }
    }

    window.Html5Qrcode = Html5Qrcode;
}());
