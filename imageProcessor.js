// imageProcessor.js (Web Worker 脚本)

// 辅助函数：计算文本换行 (和主线程的wrapText功能类似, 但为了worker独立需要重新定义)
function wrapText(context, text, maxWidth, fontSize, fontFamily, isBold, isItalic) {
    const words = text.split('');
    let line = '';
    let lines = [];
    
    // 强制设置字体以便准确测量
    let fontStyle = '';
    if (isItalic) fontStyle += 'italic ';
    if (isBold) fontStyle += 'bold ';
    fontStyle += `${fontSize}px ${fontFamily}`;
    context.font = fontStyle;

    for (let n = 0; n < words.length; n++) {
        let testLine = line + words[n];
        let metrics = context.measureText(testLine);
        let testWidth = metrics.width;

        if (testWidth > maxWidth && n > 0) {
            lines.push({ text: line, width: context.measureText(line).width });
            line = words[n];
        } else {
            line = testLine;
        }
    }
    lines.push({ text: line, width: context.measureText(line).width });
    
    const lineHeight = fontSize * 1.2; // 1.2 是行高因子
    const totalTextHeight = lines.length * lineHeight;
    
    return { lines: lines, totalTextHeight: totalTextHeight };
}

// 辅助函数：绘制水印（和主线程的drawWatermark功能类似）
function drawWatermark(context, watermark) { // 移除了 isSelected 参数，因为 Worker 只负责绘制最终效果
    context.save();

    const centerX = watermark.x + watermark.width / 2;
    const centerY = watermark.y + watermark.height / 2;
    context.translate(centerX, centerY);
    context.rotate(watermark.rotation * Math.PI / 180);
    context.translate(-centerX, -centerY);

    // 绘制背景
    if (watermark.backgroundOpacity > 0) {
        context.globalAlpha = watermark.backgroundOpacity;
        context.fillStyle = watermark.backgroundColor;
        context.fillRect(watermark.x, watermark.y, watermark.width, watermark.height);
    }

    // 绘制文本
    context.globalAlpha = watermark.opacity;
    let fontStyle = '';
    if (watermark.isItalic) fontStyle += 'italic ';
    if (watermark.isBold) fontStyle += 'bold ';
    // 修复：将 waterFamily 改为 watermark.fontFamily
    fontStyle += `${watermark.fontSize}px ${watermark.fontFamily}`; 
    context.font = fontStyle;
    context.fillStyle = watermark.fontColor;
    context.textAlign = watermark.textAlign;
    context.textBaseline = watermark.textBaseline;

    const textMaxWidth = watermark.width - watermark.padding * 2;
    const wrapped = wrapText(context, watermark.text, textMaxWidth, watermark.fontSize, watermark.fontFamily, watermark.isBold, watermark.isItalic);
    
    const lineHeight = watermark.fontSize * 1.2;
    const totalTextHeight = wrapped.totalTextHeight;

    // 计算文本起始Y坐标，使其在水印框内垂直居中
    // 因为textBaseline是'middle'，所以文本的Y坐标是行高的中心，而不是顶部
    let startTextY = watermark.y + watermark.height / 2 - totalTextHeight / 2 + lineHeight / 2;

    wrapped.lines.forEach((lineObj, i) => {
        let textX;
        if (watermark.textAlign === 'center') {
            textX = watermark.x + watermark.width / 2;
        } else { // 默认为left
            textX = watermark.x + watermark.padding;
        }
        
        context.fillText(lineObj.text, textX, startTextY + i * lineHeight);

        // 绘制下划线
        if (watermark.isUnderline) {
            const metrics = context.measureText(lineObj.text); 
            const underlineY = startTextY + i * lineHeight + watermark.fontSize / 2 + 2; // 下划线位置
            let underlineStartX = textX;
            if (watermark.textAlign === 'center') {
                underlineStartX -= metrics.width / 2;
            }
            context.strokeStyle = watermark.fontColor;
            context.lineWidth = Math.max(1, watermark.fontSize / 20);
            context.beginPath();
            context.moveTo(underlineStartX, underlineY);
            context.lineTo(underlineStartX + metrics.width, underlineY);
            context.stroke();
        }
    });

    context.restore();
}

// 辅助函数：图片微调
function applyImageTweak(ctx, canvas, tweakAmount) {
    if (tweakAmount === 0) return; // 没有微调强度

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // 简单地在每个像素的R, G, B值上添加少量随机噪声
    // 同时可以稍微调整亮度/对比度
    for (let i = 0; i < data.length; i += 4) {
        // 随机噪声
        const noise = (Math.random() - 0.5) * tweakAmount * 2; // -tweakAmount 到 +tweakAmount
        data[i] = Math.min(255, Math.max(0, data[i] + noise));     // R
        data[i + 1] = Math.min(255, Math.max(0, data[i + 1] + noise)); // G
        data[i + 2] = Math.min(255, Math.max(0, data[i + 2] + noise)); // B
        
        // 简单亮度调整 (轻微)
        // const brightnessFactor = 1 + (Math.random() - 0.5) * tweakAmount * 0.005; // 0.005是强度因子
        // data[i] = Math.min(255, Math.max(0, data[i] * brightnessFactor));
        // data[i+1] = Math.min(255, Math.max(0, data[i+1] * brightnessFactor));
        // data[i+2] = Math.min(255, Math.max(0, data[i+2] * brightnessFactor));
    }
    ctx.putImageData(imageData, 0, 0);
}


// Web Worker 消息监听
self.onmessage = async (e) => {
    if (e.data.type === 'processImages') {
        const { filesData, options } = e.data;
        // const processedResults = []; // 这个变量在Worker中不再需要

        for (let i = 0; i < filesData.length; i++) {
            const fileData = filesData[i];
            self.postMessage({ type: 'progress', message: `正在处理 ${i + 1}/${filesData.length}：${fileData.name}` });

            try {
                // 使用 createImageBitmap 从 Data URL 加载图片
                const imageBlob = await (await fetch(fileData.dataURL)).blob();
                const imgBitmap = await createImageBitmap(imageBlob);

                const tempCanvas = new OffscreenCanvas(imgBitmap.width, imgBitmap.height); // 在Worker中使用OffscreenCanvas
                const tempCtx = tempCanvas.getContext('2d');

                const targetRatio = 3 / 4;
                let finalCanvasWidth = imgBitmap.width;
                let finalCanvasHeight = imgBitmap.height;
                let drawX = 0;
                let drawY = 0;
                let drawWidth = imgBitmap.width;
                let drawHeight = imgBitmap.height;

                if (options.resizeToRedBookRatio) {
                    const originalRatio = imgBitmap.width / imgBitmap.height;

                    if (originalRatio > targetRatio) {
                        finalCanvasHeight = imgBitmap.width / targetRatio;
                        drawY = (finalCanvasHeight - imgBitmap.height) / 2;
                    } else if (originalRatio < targetRatio) {
                        finalCanvasWidth = imgBitmap.height * targetRatio;
                        drawX = (finalCanvasWidth - imgBitmap.width) / 2;
                    }
                    if (options.redBookBackgroundColor === 'rgba(0,0,0,0)') { // 透明背景
                        finalCanvasWidth = imgBitmap.width;
                        finalCanvasHeight = imgBitmap.height;
                        drawX = 0;
                        drawY = 0;
                    }
                }

                tempCanvas.width = finalCanvasWidth;
                tempCanvas.height = finalCanvasHeight;
                tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);

                if (options.redBookBackgroundColor !== 'rgba(0,0,0,0)' && options.resizeToRedBookRatio) {
                    tempCtx.fillStyle = options.redBookBackgroundColor;
                    tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
                }

                tempCtx.drawImage(imgBitmap, 0, 0, imgBitmap.width, imgBitmap.height, drawX, drawY, drawWidth, drawHeight);

                // 绘制水印
                options.watermarks.forEach(wm => drawWatermark(tempCtx, wm)); // 移除了 isSelected 参数

                // 应用图片微调
                if (options.enableImageTweak && options.tweakAmount > 0) {
                    applyImageTweak(tempCtx, tempCanvas, options.tweakAmount);
                }

                const originalExt = fileData.name.split('.').pop().toLowerCase();
                const mimeType = originalExt === 'png' ? 'image/png' : 'image/jpeg';
                const quality = mimeType === 'image/jpeg' ? options.outputQuality : 1.0;

                const blob = await tempCanvas.convertToBlob({ type: mimeType, quality: quality });
                
                self.postMessage({
                    type: 'result',
                    name: `watermarked_${fileData.name}`,
                    blob: blob,
                    isLast: i === filesData.length - 1
                });

            } catch (error) {
                self.postMessage({ type: 'error', message: `处理文件 ${fileData.name} 失败: ${error.message}` });
                console.error(`Error processing ${fileData.name}:`, error);
            }
        }
    }
};

// 辅助函数：在 Worker 中加载图片 (返回 Promise)
// 修正为使用 fetch 和 createImageBitmap
async function loadImage(dataURL) {
    const response = await fetch(dataURL);
    const blob = await response.blob();
    return await createImageBitmap(blob);
}
