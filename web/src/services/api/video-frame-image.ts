/** Fit the complete frame onto the target canvas, retaining content with black padding. */
export async function fitVideoFrameImage(dataUrl: string, width: number, height: number): Promise<string> {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("参考图不可用：无法读取图片，请重新选择图片后生成"));
        image.src = dataUrl;
    });
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) throw new Error("参考图不可用：图片尺寸无效，请重新选择图片");
    if (Math.abs((sourceWidth / sourceHeight) / (width / height) - 1) <= 0.01) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理首尾帧参考图，请使用支持 Canvas 的浏览器重试");
    context.fillStyle = "#000000";
    context.fillRect(0, 0, width, height);
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return canvas.toDataURL("image/png");
}
