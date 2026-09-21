// import OpenAI from "openai"
// import robot from "robotjs";
// import { PNG } from "pngjs";
// import fs from "fs";
// setInterval(()=>{
//   robot.moveMouseSmooth(798, 940, 2);
//   robot.mouseClick();
// }, 10000)

// function screenToPngBuffer(screen) {
//   const { width, height, image, byteWidth, bytesPerPixel } = screen;
//   const png = new PNG({ width, height });

//   for (let y = 0; y < height; y++) {
//     for (let x = 0; x < width; x++) {
//       const srcIdx = y * byteWidth + x * bytesPerPixel;
//       const dstIdx = (y * width + x) << 2;

//       png.data[dstIdx]     = image[srcIdx + 2]; // R <- B
//       png.data[dstIdx + 1] = image[srcIdx + 1]; // G
//       png.data[dstIdx + 2] = image[srcIdx];     // B <- R
//       png.data[dstIdx + 3] = 255;               // A
//     }
//   }

//   return PNG.sync.write(png);
// }


// const client = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
//   baseURL: 'https://api.deepseek.com'
// })

// async function askScreen(question) {
//   // Capture screen
//   // const screen = robot.screen.capture();
//   // const pngBuffer = screenToPngBuffer(screen);

//   // fs.writeFileSync("screenshot.png", pngBuffer);

//   // console.log("Screenshot saved as screenshot.png");

//   // // Convert PNG → base64
//   // const base64 = pngBuffer.toString("base64");
  
  
// }



// const answer = await askScreen(
//   ""
// );
// console.log(answer);
// // run().catch(console.error)


import Anthropic from "@anthropic-ai/sdk"

// DeepSeek exposes an Anthropic-compatible endpoint at /anthropic.
// Reads ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL from the environment — see .env
const client = new Anthropic()

const response = await client.messages.create({
  model: process.env.ANTHROPIC_MODEL,
  max_tokens: 1024,
  messages: [
    {
      role: "user",
      content: "Hello, how are you?"
    }
  ]
})

// content is an array of blocks — pull the text one by type, since
// reasoning models return a `thinking` block ahead of it.
const text = response.content.find((block) => block.type === "text")
console.log(response,text?.text)