/**
 * Calculates a Difference Hash (dHash) for an image.
 * Resizes to 9x8, converts to grayscale, compares adjacent pixels.
 * Result is a 64-character binary string.
 */
export async function calculateImageHash(imageUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) { 
          reject(new Error('Could not get canvas context')); 
          return; 
        }
        
        // Resize to 9x8 to get 8x8 comparisons (64 bits)
        canvas.width = 9;
        canvas.height = 8;
        
        // Draw image stretched to 9x8
        ctx.drawImage(img, 0, 0, 9, 8);
        
        // Get pixel data
        const imageData = ctx.getImageData(0, 0, 9, 8).data;
        
        let hash = '';
        // Iterate through rows (0-7)
        for (let y = 0; y < 8; y++) {
          // Iterate through columns (0-7), comparing x with x+1
          for (let x = 0; x < 8; x++) {
            // Calculate grayscale for current pixel
            const currentIdx = (y * 9 + x) * 4;
            const currentVal = (imageData[currentIdx] + imageData[currentIdx + 1] + imageData[currentIdx + 2]) / 3;
            
            // Calculate grayscale for next pixel
            const nextIdx = (y * 9 + (x + 1)) * 4;
            const nextVal = (imageData[nextIdx] + imageData[nextIdx + 1] + imageData[nextIdx + 2]) / 3;
            
            // If left pixel is brighter than right, bit is 1, else 0
            hash += (currentVal > nextVal ? '1' : '0');
          }
        }
        resolve(hash);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = (e) => reject(e);
    // Handle data URLs directly, else load
    img.src = imageUrl;
  });
}

/**
 * Calculates the Hamming Distance between two binary hash strings.
 * Lower distance = Higher similarity.
 * Distance <= 5 usually implies <5% difference (highly similar/duplicate).
 */
export function calculateHammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) return -1;
  
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) {
      distance++;
    }
  }
  return distance;
}