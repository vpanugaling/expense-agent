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


@app.post("/ocr")
async def ocr_receipt(image: UploadFile = File(...)):
    try:
        contents = await image.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        # Upscale small images for better OCR
        if img.shape[0] < 1000:
            img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

        # Preprocess for thermal receipts
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        thresh = cv2.adaptiveThreshold(
            gray, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            11, 2
        )

        # Deskew rotated receipts
        thresh = deskew_image(thresh)

        # Stronger denoising for thermal paper
        denoised = cv2.medianBlur(thresh, 5)

        # OCR with column layout mode (better for receipts)
        text = pytesseract.image_to_string(denoised, config='--psm 4 --oem 3')

        # FIXED: Handle both string and int confidence values
        data = pytesseract.image_to_data(denoised, config='--psm 4 --oem 3', output_type=pytesseract.Output.DICT)
        confs_raw = data.get('conf', [])
        confs = []
        for c in confs_raw:
            if isinstance(c, str) and c.isdigit() and int(c) >= 0:
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
