import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkStackProps extends cdk.StackProps {
  readonly vpcId: string;
  readonly privateSubnetIds: string[];
  readonly privateSubnetAzs: string[];
  readonly vpcCidr: string;
}

/**
 * Networking for the Claude apps gateway — imports an EXISTING VPC rather
 * than creating a new one. Creates security groups and VPC endpoints within
 * that VPC.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly gatewayTaskSecurityGroup: ec2.SecurityGroup;
  public readonly adminConsoleSecurityGroup: ec2.SecurityGroup;
  public readonly databaseSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    // Import the existing VPC by ID
    this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', {
      vpcId: props.vpcId,
    });

    // Import specific private subnets
    this.privateSubnets = props.privateSubnetIds.map((subnetId, i) =>
      ec2.Subnet.fromSubnetAttributes(this, `PrivateSubnet${i + 1}`, {
        subnetId,
        availabilityZone: props.privateSubnetAzs[i],
        routeTableId: '',
      })
    );
    // Admin console goes on the same private subnets (reached via VPN, not public)
    this.publicSubnets = this.privateSubnets;

    // --- Security groups ---

    this.gatewayTaskSecurityGroup = new ec2.SecurityGroup(this, 'GatewayTaskSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for the Claude gateway ECS Express Mode Fargate task',
      allowAllOutbound: true,
    });

    this.adminConsoleSecurityGroup = new ec2.SecurityGroup(this, 'AdminConsoleSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for the admin console ECS Express Mode Fargate task',
      allowAllOutbound: true,
    });

    this.databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for the Aurora Serverless v2 cluster backing the gateway',
      allowAllOutbound: true,
    });
    this.databaseSecurityGroup.addIngressRule(
      this.gatewayTaskSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow the gateway task to reach Postgres',
    );

    // --- VPC interface endpoints ---
    const vpcEndpointSecurityGroup = new ec2.SecurityGroup(this, 'VpcEndpointSecurityGroup', {
      vpc: this.vpc,
      description: 'SG for VPC interface endpoints (bedrock-runtime, secretsmanager)',
      allowAllOutbound: true,
    });
    vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(props.vpcCidr),
      ec2.Port.tcp(443),
      'Allow HTTPS from within the VPC',
    );

    this.vpc.addInterfaceEndpoint('BedrockRuntimeEndpoint', {
      service: new ec2.InterfaceVpcEndpointService(`com.amazonaws.${cdk.Stack.of(this).region}.bedrock-runtime`),
      subnets: { subnets: this.privateSubnets },
      securityGroups: [vpcEndpointSecurityGroup],
      privateDnsEnabled: true,
    });

    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnets: this.privateSubnets },
      securityGroups: [vpcEndpointSecurityGroup],
      privateDnsEnabled: true,
    });
  }
}
