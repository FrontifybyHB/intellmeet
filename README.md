
# IntellMeet 🤖

### AI-Powered Enterprise Meeting & Collaboration Platform

IntellMeet is a full-stack meeting and collaboration platform designed to help remote and hybrid teams communicate, collaborate, and turn meetings into actionable outcomes.

The project aims to combine real-time video meetings, in-meeting chat, AI-powered meeting summaries, transcription, and action-item management in one application.

> **Project status:** In development

## ✨ Planned Features

- **Authentication & Profiles** — Secure registration, login, and user profiles.
- **Video Meetings** — Create and join meetings with audio and video using WebRTC.
- **Screen Sharing** — Share your screen during meetings.
- **Real-Time Chat** — Exchange messages using Socket.io.
- **AI Meeting Intelligence** — Generate meeting summaries and extract action items from transcripts.
- **Meeting History** — Access saved meeting information and summaries.
- **Task Management** — Track action items and their assigned owners.
- **Responsive Dashboard** — Access the application across desktop and mobile screens.

Features will be implemented and documented as development progresses.

## 🛠️ Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React, Vite |
| Backend | Node.js, Express.js |
| Database | MongoDB, Mongoose |
| Real-Time Communication | Socket.io |
| Audio/Video | WebRTC |
| AI Integration | OpenAI API or an agreed compatible provider |
| Version Control | Git, GitHub |
| CI/CD | GitHub Actions (planned) |
| Deployment | HTTPS-enabled frontend and backend hosting |

## 🏗️ Project Structure

```text
intellmeet/
├── client/                         # React + Vite frontend
│   ├── public/
│   ├── src/
│   │   ├── assets/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── services/
│   │   ├── hooks/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── .env.example
│   ├── package.json
│   └── vite.config.ts
├── server/                         # Node.js + Express backend
│   ├── src/
│   │   ├── config/
│   │   │   └── db.js
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── models/
│   │   ├── middleware/
│   │   ├── services/
│   │   ├── sockets/
│   │   ├── utils/
│   │   ├── app.js
│   │   └── server.js
│   ├── .env.example
│   └── package.json
├── docs/
│   └── api-contracts.md
├── .github/
│   └── workflows/
├── .gitignore
├── LICENSE
└── README.md
```

The structure may evolve as new modules are implemented.

## 🚀 Getting Started

### Prerequisites

Install the following before starting:

- Node.js and npm
- Git
- A MongoDB instance, such as MongoDB Atlas
- A code editor such as Visual Studio Code

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/intellmeet.git
cd intellmeet
```

Replace `YOUR_USERNAME` with the repository owner's GitHub username or organization.

### 2. Set up the frontend

```bash
cd client
npm install
npm run dev
```

Vite will display the local development URL in your terminal.

### 3. Set up the backend

Open a second terminal from the repository root:

```bash
cd server
npm install
```

Create a local `.env` file inside `server/` and configure the required environment variables.

Example:

```env
PORT=3000
CLIENT_URL=http://localhost:5173
MONGODB_URI=your_mongodb_connection_string
JWT_SECRET=replace_with_a_secure_random_secret
OPENAI_API_KEY=your_api_key_if_required
```

Do not commit this file or share its secret values.

Start the backend:

```bash
npm run dev
```

If the backend health endpoint has been implemented, verify it at:

`http://localhost:3000/api/health`

### Environment Configuration

Keep environment variables out of source control. Update `.env.example` whenever the application introduces a new required variable, using placeholder values only.

## 🔀 Development Workflow

We use a feature-branch workflow to keep the `main` branch stable.

1. Pull the latest changes from `main`.
2. Create a branch for your issue.
3. Implement and test your changes locally.
4. Commit using a descriptive message.
5. Push your branch and open a pull request.
6. Request a review and resolve feedback.
7. Merge only after the required checks pass.

Example:

```bash
git switch main
git pull origin main
git switch -c feat/your-feature

# Implement and test your changes

git add .
git commit -m "feat: describe your feature"
git push -u origin feat/your-feature
```

Open a pull request on GitHub targeting `main`.

### Commit Message Examples

- `feat: add meeting creation`
- `fix: handle socket reconnection`
- `docs: update setup instructions`
- `test: add authentication tests`
- `chore: configure deployment workflow`

## 🔐 Security Guidelines

- Never commit API keys, passwords, tokens, or `.env` files.
- Hash passwords securely.
- Validate user input on the backend.
- Protect private meeting and task resources with authorization checks.
- Use HTTPS in production.
- Apply appropriate rate limits and secure configuration.
- Do not expose private meeting data in application logs.

## 🧪 Testing

Testing will cover the main user workflows, API validation, authentication, meeting access, real-time communication, and AI processing.

Testing commands and coverage information will be documented as the test suite is added.

## 🌐 Deployment

The deployment plan includes:

- A publicly accessible HTTPS frontend.
- A backend host supporting the required API and persistent real-time connections.
- Secure production environment variables.
- A hosted MongoDB database with restricted access.
- Automated build and test checks through GitHub Actions.

Live demo URL: *To be added*

## 👥 Team

IntellMeet is developed by a four-member team.

| Role | Responsibility |
|---|---|
| Team Lead | Project coordination, DevOps, hosting, CI/CD, integration |
| Developer 2 | Backend APIs and authentication |
| Developer 3 | Frontend and user interface |
| Developer 4 | Real-time meeting features and AI integration |

Update this table with the team members' names and final responsibilities.

## 🗺️ Project Roadmap

- [ ] Repository and development environment setup
- [ ] Authentication and user profiles
- [ ] Meeting creation and joining
- [ ] Real-time video, audio, and chat
- [ ] Screen sharing
- [ ] AI transcription and meeting summaries
- [ ] Action-item extraction and task tracking
- [ ] Meeting history and dashboard
- [ ] Deployment and CI/CD
- [ ] Testing, documentation, and demo

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.

## 🙌 Acknowledgements

Built as a collaborative full-stack development project exploring real-time communication, AI-powered workflows, and modern web application deployment.
