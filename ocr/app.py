from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
import cv2
import numpy as np
import pytesseract

app = FastAPI()


def deskew_image(image):
    """Detect and correct skew angle in image."""
    coords = np.column_stack(np.where(image > 0))
    if len(coords) < 10:
        return image
    angle = cv2.minAreaRect(coords)[-1]
    if angle < -45:
        angle = 90 + angle
    if abs(angle) > 0.5:
        (h, w) = image.shape[:2]
        center = (w // 2, h // 2)
        M = cv2.getRotationMatrix2D(center, angle, 1.0)
        image = cv2.warpAffine(
            image, M, (w, h),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_REPLICATE
        )
    return image


def preprocess_receipt(img):
    """Enhanced preprocessing for thermal receipts."""

    # 1. Upscale small images (target ~1500px height for better OCR)
    if img.shape[0] < 1500:
        scale = 1500 / img.shape[0]
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    # 2. Convert to grayscale
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # 3. CLAHE - Critical for thermal paper contrast enhancement
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    # 4. Denoise while preserving edges
    denoised = cv2.fastNlMeansDenoising(enhanced, h=10)

    # 5. Sharpen (unsharp mask for blurry images)
    gaussian = cv2.GaussianBlur(denoised, (0, 0), 3)
    sharpened = cv2.addWeighted(denoised, 1.5, gaussian, -0.5, 0)

    # 6. Adaptive threshold (block size 15 for uneven lighting)
    thresh = cv2.adaptiveThreshold(
        sharpened, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        15, 4
    )

    # 7. Morphological close to fill small gaps in characters
    kernel = np.ones((1, 1), np.uint8)
    cleaned = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

    # 8. Deskew rotated receipts
    cleaned = deskew_image(cleaned)

    # 9. Final light denoise
    final = cv2.medianBlur(cleaned, 3)

    return final


@app.post("/ocr")
async def ocr_receipt(image: UploadFile = File(...)):
    try:
        contents = await image.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        # Apply enhanced preprocessing
        processed = preprocess_receipt(img)

        # OCR with optimized config for receipts
        config = '--psm 4 --oem 3 -c preserve_interword_spaces=1'
        text = pytesseract.image_to_string(processed, config=config)

        # Get confidence scores
        data = pytesseract.image_to_data(processed, config=config, output_type=pytesseract.Output.DICT)
        confs_raw = data.get('conf', [])
        confs = []
        for c in confs_raw:
            if isinstance(c, str) and c.lstrip('-').isdigit() and int(c) >= 0:
                confs.append(int(c))
            elif isinstance(c, int) and c >= 0:
                confs.append(c)

        confidence = float(sum(confs) / len(confs) / 100.0) if confs else 0.0

        return JSONResponse({
            "text": text.strip(),
            "confidence": min(max(confidence, 0.0), 1.0)
        })
    except Exception as e:
        print(f"OCR error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)}
        )
