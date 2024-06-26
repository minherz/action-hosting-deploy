/**
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  endGroup,
  getInput,
  setFailed,
  setOutput,
  startGroup,
} from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { existsSync, unlinkSync } from "fs";
import { createGacFile } from "./createGACFile";
import {
  deployPreview,
  deployProductionSite,
  ErrorResult,
  interpretChannelDeployResult,
} from "./deploy";
import { getChannelId } from "./getChannelId";
import {
  getURLsMarkdownFromChannelDeployResult,
  postChannelSuccessComment,
} from "./postOrUpdateComment";

// Inputs defined in action.yml
const expires = getInput("expires");
const projectId = getInput("projectId");
const googleApplicationCredentials = getInput("firebaseServiceAccount", {
  required: true,
});
const configuredChannelId = getInput("channelId");
const token = process.env.GITHUB_TOKEN || getInput("repoToken");
const octokit = token ? getOctokit(token) : undefined;
const entryPoint = getInput("entryPoint");
const target = getInput("target");
const firebaseToolsVersion = getInput("firebaseToolsVersion");
const disableComment = getInput("disableComment");

async function run() {
  try {
    startGroup("Verifying setup parameters");

    if (entryPoint !== ".") {
      console.log(`Changing to directory: ${entryPoint}`);
      try {
        process.chdir(entryPoint);
      } catch (err) {
        throw Error(`Error changing to directory ${entryPoint}: ${err}`);
      }
    }
    if (existsSync("./firebase.json")) {
      console.log("firebase.json file found. Continuing deploy.");
    } else {
      throw Error(
        "firebase.json file not found. If your firebase.json file is not in the root of your repo, edit the entryPoint option of this GitHub action."
      );
    }
    const gacFilename = await createGacFile(googleApplicationCredentials);
    console.log("Google Application Credentials acquired.");
    endGroup();

    if (configuredChannelId === "live") {
      startGroup("Deploying to production site");
      await deployToProduction(gacFilename);
      endGroup();
    } else {
      const channelId = getChannelId(configuredChannelId, context);
      startGroup(`Deploying to Firebase preview channel ${channelId}`);
      await deployToPreviewChannel(gacFilename, channelId);
      endGroup();
    }

    // cleanup
    if (gacFilename !== googleApplicationCredentials) {
      unlinkSync(gacFilename);
    }
  } catch (e) {
    setFailed(e.message);
  }
  return undefined;
}

async function deployToProduction(gacFilePath: string) {
  const deployment = await deployProductionSite(gacFilePath, {
    projectId,
    target,
    firebaseToolsVersion,
  });
  if (deployment.status === "error") {
    throw Error((deployment as ErrorResult).error);
  }
  const hostname = target ? `${target}.web.app` : `${projectId}.web.app`;
  const url = `https://${hostname}/`;
  console.log({
    details_url: url,
    conclusion: "success",
    output: {
      title: `Production deploy succeeded`,
      summary: `[${hostname}](${url})`,
    },
  });
  return undefined;
}

async function deployToPreviewChannel(gacFilePath: string, channelId: string) {
  const deployment = await deployPreview(gacFilePath, {
    projectId,
    expires,
    channelId,
    target,
    firebaseToolsVersion,
  });
  if (deployment.status === "error") {
    throw Error((deployment as ErrorResult).error);
  }

  const { expireTime, urls } = interpretChannelDeployResult(deployment);
  setOutput("urls", urls);
  setOutput("expire_time", expireTime);
  setOutput("details_url", urls[0]);

  if (disableComment === "true") {
    console.log(
      `Commenting on PR is disabled with "disableComment: ${disableComment}"`
    );
  } else if (token && !!context.payload.pull_request && !!octokit) {
    const commitId = context.payload.pull_request?.head.sha.substring(0, 7);

    await postChannelSuccessComment(octokit, context, deployment, commitId);
  }
  console.log({
    details_url: urls[0],
    conclusion: "success",
    output: {
      title: `Deploy preview succeeded`,
      summary: getURLsMarkdownFromChannelDeployResult(deployment),
    },
  });
  return undefined;
}

run();
