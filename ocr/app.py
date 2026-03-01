from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
import cv2
import numpy as np
import pytesseract

app = FastAPI()

@app.post("/ocr")
async def ocr_receipt(image: UploadFile = File(...)):
    try:
        contents = await image.read()
        nparr = np.frombuffer(contents, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        # Preprocess for thermal receipts
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        thresh = cv2.adaptiveThreshold(
            gray, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            11, 2
        )
        denoised = cv2.medianBlur(thresh, 3)

        # OCR
        text = pytesseract.image_to_string(denoised, config='--psm 6')

        # FIXED: Handle both string and int confidence values
        data = pytesseract.image_to_data(denoised, output_type=pytesseract.Output.DICT)
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
