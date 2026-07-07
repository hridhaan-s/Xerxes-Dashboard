# XERXES // WORKSPACE ENGINE

An experimental, high-precision research assistant powered by local Computer Vision edge pipelines to monitor workspace posture, screen distance, and real-time focus analytics. Built 100% client-side to guarantee data privacy.

**Engine Architect:** HRIDHAAN  
**Deployment Suite:** [bitbuzz.app/Xerxes](https://bitbuzz.app/Xerxes)

---

## 🚀 Deployment Instructions

Because webcam access requires secure browser permissions, the dashboard cannot be run from a local file path (`file:///`) in production. It must be hosted over a secure connection (**HTTPS**).

### Option 1: Quick Deployment (Vercel or Netlify)
1. Drop the `index.html` file into a new folder on your computer.
2. Drag and drop that folder directly onto [Vercel](https://vercel.com) or [Netlify](https://netlify.com).
3. Copy your live production URL link (e.g., `your-app.vercel.app`).

### Option 2: GitHub Pages
1. Push your `index.html` file to a public GitHub repository.
2. Go to **Settings** > **Pages** inside your repository dashboard.
3. Set the build source branch to `main` (or `master`) and hit save. Your site will live at `https://<your-username>.github.io/<repo-name>/`.

---

## 🧩 Extension Integration Step

To allow cross-tab desktop notifications to route smoothly back to your engine platform:

1. Open your extension development folder (`xerxes-extension`).
2. Open `background.js` or `content.js` and ensure click redirection actions point to your deployed link structure:
   ```javascript
   chrome.notifications.onClicked.addListener(() => {
       chrome.tabs.create({ url: "[https://bitbuzz.app/Xerxes](https://bitbuzz.app/Xerxes)" });
   });
