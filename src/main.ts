import * as core from "@actions/core";
import * as crypto from "crypto";
import { ContainerAppsAPIClient, ContainerApp, TrafficWeight, Revision } from "@azure/arm-appcontainers";
import { TokenCredential, DefaultAzureCredential } from "@azure/identity";
import { AuthorizerFactory } from "azure-actions-webclient/AuthorizerFactory";
import { IAuthorizer } from "azure-actions-webclient/Authorizer/IAuthorizer";

import { TaskParameters } from "./taskparameters";

const prefix = !!process.env.AZURE_HTTP_USER_AGENT ? `${process.env.AZURE_HTTP_USER_AGENT}` : "";
const MAX_REVISION_NAME_LENGTH = 63;

async function main() {

  try {
    // Set user agent variable.
    const usrAgentRepo = crypto.createHash('sha256').update(`${process.env.GITHUB_REPOSITORY}`).digest('hex');
    const actionName = 'ACAReviewApps';
    const userAgentString = (!!prefix ? `${prefix}+` : '') + `GITHUBACTIONS_${actionName}_${usrAgentRepo}`;
    core.exportVariable('AZURE_HTTP_USER_AGENT', userAgentString);

    const endpoint: IAuthorizer = await AuthorizerFactory.getAuthorizer();
    const taskParams = TaskParameters.getTaskParams(endpoint);
    const credential: TokenCredential = new DefaultAzureCredential();
    // The revision name format is described in this documentation
    // https://learn.microsoft.com/en-us/azure/container-apps/revisions#revision-name-suffix
    const revisionName = `${taskParams.containerAppName}--${taskParams.revisionNameSuffix}`;
    if (revisionName.length > MAX_REVISION_NAME_LENGTH) throw new Error(`The total length of revision name ${revisionName} is ${revisionName.length}. This must be less than 64.`);

    console.log("Predeployment Steps Started");
    const client = new ContainerAppsAPIClient(credential, taskParams.subscriptionId);

    const currentAppProperty = await client.containerApps.get(taskParams.resourceGroup, taskParams.containerAppName);

    if (taskParams.deactivateRevisionMode) {
      await deactivateRevision({
        client,
        resourceGroup: taskParams.resourceGroup,
        containerAppName: taskParams.containerAppName,
        traffic: currentAppProperty.configuration?.ingress?.traffic || [],
        revisionName: `${taskParams.containerAppName}--${taskParams.revisionNameSuffix}`,
      });
      return;
    }

    const traffics = currentAppProperty.configuration!.ingress!.traffic!.filter((traffic: TrafficWeight) => {
      if (!traffic.weight || traffic.weight === 0) return false
      if (traffic.latestRevision) {
        traffic.latestRevision = false;
        traffic.revisionName = currentAppProperty.latestRevisionName;
      }
      return true;
    }) || [];
    traffics.push({
      revisionName: `${taskParams.containerAppName}--${taskParams.revisionNameSuffix}`,
      weight: 0,
      latestRevision: false
    })

    const ingressConfig: {
      external: boolean,
      targetPort?: number,
      traffic?: any[],
      customDomains?: any[]
    } = {
      external: currentAppProperty.configuration!.ingress!.external!,
      targetPort: currentAppProperty.configuration!.ingress!.targetPort!,
      traffic: traffics,
      customDomains: currentAppProperty.configuration!.ingress!.customDomains! || []
    }

    const scaleConfig: {
      maxReplicas: number,
      minReplicas: number,
      rules: any[]
    } = {
      maxReplicas: currentAppProperty.template!.scale!.maxReplicas!,
      minReplicas: currentAppProperty.template!.scale!.minReplicas!,
      rules: [{
        "name": 'httpscalingrule',
        "custom": {
          "type": 'http',
          "metadata": {
            "concurrentRequests": '50'
          }
        }
      }]
    }

    const networkConfig: {
      dapr: object,
      ingress?: object,
      activeRevisionsMode?: string
    } = {
      dapr: currentAppProperty.configuration!.dapr!,
      ingress: ingressConfig,
      activeRevisionsMode: "Multiple"
    }
    if (ingressConfig.external == false || ingressConfig.external == undefined) {
      delete networkConfig.ingress
    }

    const containerConfig = [
      {
        "name": taskParams.containerAppName,
        "image": taskParams.imageName
      }
    ]

    const containerAppEnvelope: ContainerApp = {
      configuration: networkConfig,
      location: currentAppProperty.location,
      managedEnvironmentId: currentAppProperty.managedEnvironmentId,
      template: {
        containers: containerConfig,
        scale: scaleConfig,
        revisionSuffix: taskParams.revisionNameSuffix
      }
    };

    console.log("Deployment Step Started");

    // update
    await client.containerApps.beginUpdateAndWait(
      taskParams.resourceGroup,
      taskParams.containerAppName,
      containerAppEnvelope,
    );

    // check if added revision is included in revision list
    const addedRevision = await client.containerAppsRevisions.getRevision(
      taskParams.resourceGroup,
      taskParams.containerAppName,
      `${taskParams.containerAppName}--${taskParams.revisionNameSuffix}`
    )
    if (!addedRevision) throw new Error(`Failed to add revision ${taskParams.containerAppName}--${taskParams.revisionNameSuffix}.`);

    if (ingressConfig.external == true && addedRevision.fqdn) {
      const appUrl = "https://" + addedRevision.fqdn + "/"
      core.setOutput("app-url", appUrl);
      console.log("Your App has been deployed at: " + appUrl);
    }
    console.log("Deployment Succeeded");
  }
  catch (error: string | any) {
    console.log("Deployment Failed with Error: " + error);
    core.setFailed(error);
  }
  finally {
    // Reset AZURE_HTTP_USER_AGENT.
    core.exportVariable('AZURE_HTTP_USER_AGENT', prefix);
  }
}

async function deactivateRevision(params: any) {
  const { client, resourceGroup, containerAppName, traffic, revisionName } = params;
  const targetRevisions = traffic.filter((r: any) => r.revisionName === revisionName);

  // Check traffic weight of the target revision
  if (targetRevisions.length > 0 && targetRevisions.reduce((prev: number, curr: any) => prev + curr.weight, 0) !== 0)
    throw new Error(`Traffic weight of revision ${revisionName} under container app ${containerAppName} is not 0. Set 0 to the traffic weight of the revision before deactivation.`);
 　　
  console.log("Deactivation Step Started");
  await client.containerAppsRevisions.deactivateRevision(resourceGroup, containerAppName, revisionName);
  
  // check if revision's status is deactived
  const deactiveRevision = await client.containerAppsRevisions.getRevision(
    resourceGroup,
    containerAppName,
    revisionName
  )
  if(deactiveRevision.active) {
    throw new Error(`The revision ${revisionName} under container app ${containerAppName} can't be deactivated. Check the Azure Portal for details.`);
  } else {
    console.log("Deactivation Step Succeeded");
  }
}

main();
